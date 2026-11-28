import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDailyPlanPrompt, createDailyPlanService } from "../src/services/dailyPlanService.js";

const maria = { memoryOwnerId: "user:maria", role: "member" };

test("the plan uses the profile, the person's own calendar and mail subjects", async () => {
  let asked;
  const service = createDailyPlanService({
    askAi: async ({ input }) => {
      asked = input;
      return "План";
    },
    profileContext: async () => "[ПРОФИЛ] Мария",
    belongs: async (id, owner) => id === "g1" && owner === maria,
    calendar: async () => [{ title: "Среща с банката", start: "2026-11-26T09:00:00+02:00" }],
    mail: async () => [{ from: "Иван", subject: "Офертата", unread: true, snippet: "ТАЙНО" }],
    now: () => new Date("2026-11-26T06:00:00Z"),
  });
  const result = await service.plan(maria, { googleSessionId: "g1", note: "искам да спортувам" });
  assert.equal(result.text, "План");
  assert.deepEqual(result.sources, { profile: true, calendar: 1, mail: 1 });
  const data = asked[1].content;
  assert.match(data, /Мария/u);
  assert.match(data, /Среща с банката/u);
  assert.match(data, /\(непрочетен\) Иван · Офертата/u);
  assert.match(data, /искам да спортувам/u);
  assert.doesNotMatch(data, /ТАЙНО/u);
  assert.match(asked[0].content, /не инструкции/u);
  assert.match(asked[0].content, /човекът решава/u);
});

test("someone else's Google connection is never read", async () => {
  let read = 0;
  const service = createDailyPlanService({
    askAi: async () => "План",
    profileContext: async () => "",
    belongs: async () => false,
    calendar: async () => { read += 1; return []; },
    mail: async () => { read += 1; return []; },
  });
  const result = await service.plan(maria, { googleSessionId: "чужда" });
  assert.equal(read, 0);
  assert.deepEqual(result.sources, { profile: false, calendar: null, mail: null });
});

test("a Google error does not stop the plan", async () => {
  const service = createDailyPlanService({
    askAi: async () => "План",
    profileContext: async () => "",
    belongs: async () => true,
    calendar: async () => { throw new Error("expired"); },
    mail: async () => [],
  });
  assert.deepEqual((await service.plan(maria, { googleSessionId: "g" })).sources, { profile: false, calendar: null, mail: 0 });
});

test("a calendar or mail turned off with „Разкачи“ is not read, and the plan says so", async () => {
  let read = [];
  let asked;
  const base = {
    askAi: async ({ input }) => {
      asked = input;
      return "План";
    },
    profileContext: async () => "",
    belongs: async () => true,
    calendar: async () => {
      read.push("calendar");
      return [{ title: "Среща с банката", start: "2026-11-26T09:00:00+02:00" }];
    },
    mail: async () => {
      read.push("mail");
      return [{ from: "Иван", subject: "Офертата" }];
    },
  };
  const mailOff = createDailyPlanService({
    ...base,
    capabilitiesOff: async (ownerId) => {
      assert.equal(ownerId, "user:maria");
      return new Set(["mail.read", "mail.search", "mail.send"]);
    },
  });
  const result = await mailOff.plan(maria, { googleSessionId: "g1" });
  assert.deepEqual(read, ["calendar"]);
  assert.deepEqual(result.sources, { profile: false, calendar: 1, mail: "off" });
  assert.match(asked[1].content, /Среща с банката/u);
  assert.match(asked[1].content, /Пощата е разкачена от човека в „Инструменти“/u);
  assert.doesNotMatch(asked[1].content, /Офертата|Пощата не е свързана/u);
  // When the switches cannot be read, neither is read (as if both were off).
  read = [];
  const unreadable = createDailyPlanService({
    ...base,
    capabilitiesOff: async () => Object.assign(new Set(["calendar.read", "mail.read"]), { unavailable: true }),
  });
  const closed = await unreadable.plan(maria, { googleSessionId: "g1" });
  assert.deepEqual(read, []);
  // Not the person's choice: the plan says only that they were not read.
  assert.deepEqual(closed.sources, { profile: false, calendar: "unavailable", mail: "unavailable" });
  assert.match(asked[1].content, /Календарът не се прочете за този план/u);
  assert.match(asked[1].content, /Пощата не се прочете за този план/u);
  assert.doesNotMatch(asked[1].content, /Календарът е разкачен|Пощата е разкачена|Календарът не е свързан\.|Пощата не е свързана\./u);
  // Google not connected and the switches unreadable: still „not connected“,
  // so the page keeps offering „свържи „Моят Google““.
  const unconnected = createDailyPlanService({
    ...base,
    belongs: async () => false,
    capabilitiesOff: async () => Object.assign(new Set(["calendar.read", "mail.read"]), { unavailable: true }),
  });
  const bare = await unconnected.plan(maria, { googleSessionId: "" });
  assert.deepEqual(read, []);
  assert.deepEqual(bare.sources, { profile: false, calendar: null, mail: null });
  assert.match(asked[1].content, /Календарът не е свързан/u);
  // The page asks to connect Google only when it is not connected.
  const page = readFileSync(new URL("../public/daily-plan.js", import.meta.url), "utf8");
  assert.match(page, /data\.sources\?\.calendar === null \? text\("свържи „Моят Google“/u);
});

test("the prompt says plainly what is missing", () => {
  const [, user] = buildDailyPlanPrompt({ today: "четвъртък", profile: "", events: null, mail: null });
  assert.match(user.content, /Календарът не е свързан/u);
  assert.match(user.content, /Пощата не е свързана/u);
});

test("the route is for every signed-in account and charged as a request", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /"\/api\/daily-plan",\s*requireOwnerSession,\s*paidAiRateLimiter,\s*createDailyPlanRouter/u);
  assert.match(read("../src/routes/dailyPlanRouter.js"), /router\.post\("\/", publicAiBudgetContext/u);
  assert.match(read("../public/ui-refresh.js"), /data-plus="day"/u);
});

test("„Моята седмица“ reads seven days of the calendar and asks for a weekly review", async () => {
  let asked = null;
  let calendarPeriod = "";
  const service = createDailyPlanService({
    askAi: async ({ input }) => {
      asked = input;
      return "Седмицата";
    },
    profileContext: async () => "",
    belongs: async () => true,
    calendar: async (_id, period) => {
      calendarPeriod = period;
      return [];
    },
    mail: async () => [],
  });
  const result = await service.plan({ memoryOwnerId: "u1" }, { googleSessionId: "g", period: "week" });
  assert.equal(result.text, "Седмицата");
  assert.equal(calendarPeriod, "week");
  assert.match(asked[0].content, /прегледа му за седмицата/u);
  assert.match(asked[1].content, /няма събития в следващите 7 дни/u);
  // Anything else falls back to the day plan.
  await service.plan({ memoryOwnerId: "u1" }, { googleSessionId: "g", period: "year" });
  assert.equal(calendarPeriod, "day");
  assert.match(asked[0].content, /плана му за днес/u);
  const router = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/routes/dailyPlanRouter.js", import.meta.url), "utf8"));
  assert.match(router, /period: req\.body\?\.period === "week" \? "week" : "day"/u);
});
