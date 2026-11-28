import assert from "node:assert/strict";
import test from "node:test";

import {
  formatOwnWriteReply,
  formatSentEmailReply,
  isOwnCommandEmail,
  ownCommandWriteOf,
  ownWriteFailureReply,
  readPlainWordsPlan,
  sentEmailFailureReply,
  withPlainWordsRequests,
} from "../src/routes/chat.js";
import { sendMcpAgentMessage } from "../src/services/mcpAgentConversationService.js";
import { hasMailWords, sofiaNow } from "../src/services/plainIntentService.js";

// Item 3, fix 1 (RADKO 28.11 05:26–05:41): an email and the mailbox in the
// person's own words. These are his messages from the live site.
const mailIntent = (fields = {}) => ({
  action: "mail.send",
  recipient: "",
  recipientName: "",
  subject: "",
  body: "",
  title: "",
  date: "",
  time: "",
  query: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  taskText: "",
  taskDate: "",
  picture: "",
  durationMinutes: 0,
  ...fields,
});

function reader(answer) {
  const calls = [];
  const read = async (options) => {
    calls.push(options);
    return typeof answer === "function" ? answer(options) : answer;
  };
  return { calls, read };
}

test("his words for mail are mail words; other words are not", () => {
  for (const words of [
    "ISKAM DA PATI MEIL DO MEN",
    "ПРАТИ МЕЛ ДА МИЯ",
    "каво имам в пошата днес покажи ми последните мейли",
    "покажи ми последните имейли в gmail",
    "прати емайл на иван",
    "iskam da prata mail do men",
  ]) {
    assert.equal(hasMailWords(words), true, words);
  }
  for (const words of [
    "какво ми е деня днес",
    "кажи дали видеото да е вертикално за телефон.",
    "мелница",
    "нарисувай ми картинка звезда над морето през ноща",
  ]) {
    assert.equal(hasMailWords(words), false, words);
  }
});

test("the reader is asked for words of a tool, for an answer to its own question, and for a yes to a tool step only", async () => {
  const { calls, read } = reader(mailIntent({ recipient: "me", body: "Здраве" }));
  const apiKey = "stand-in";

  // Mail words: asked.
  const plan = await readPlainWordsPlan({ message: "ПРАТИ МЕЛ ДА МИЯ здраве", apiKey, read });
  assert.equal(plan.type, "requests");
  assert.equal(calls.length, 1);

  // The answer to its own question („Какво да пише в имейла?“): asked, with
  // the turns before it.
  const turns = [
    { role: "user", content: "ISKAM DA PATI MEIL DO MEN" },
    { role: "assistant", content: "Какво да пише в имейла? Напиши текста (и темата, ако искаш) и го пращам веднага." },
  ];
  await readPlainWordsPlan({ message: "ТУК ПРИ ПОСТ ЗДРАВЕ", turns, apiKey, read });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].turns, turns);

  // A yes to a step about a tool: asked. A yes to a step with no tool
  // words, or with no step: not asked.
  await readPlainWordsPlan({ message: "да", step: "кажи „да“ и пращам имейла до теб.", apiKey, read });
  assert.equal(calls.length, 3);
  for (const step of ["", "кажи дали текстът да е по-кратък."]) {
    assert.deepEqual(await readPlainWordsPlan({ message: "да", step, apiKey, read }), { type: "none" });
  }
  assert.equal(calls.length, 3);

  // No words of any tool, or a project's task: not asked.
  for (const message of ["здравей", "как си днес", "благодаря ти", "Коя е следващата задача?", "Как работим по техническа задача?"]) {
    assert.deepEqual(await readPlainWordsPlan({ message, apiKey, read }), { type: "none" });
  }
  assert.equal(calls.length, 3);

  // Words of the other tools (item 3, all at once): asked.
  for (const message of [
    "какво ми е деня днес",
    "нарисувай ми звезда",
    "кви задачи имам отворени",
    "моите задачи",
    "добави задача да се обадя на банката утре",
    "намери иван в контактите",
    "покажи ми последните файлове в драйва",
    "запиши ми среща утре в 10 с иван в календара",
  ]) {
    await readPlainWordsPlan({ message, apiKey, read });
  }
  assert.equal(calls.length, 11);

  // The exact command keeps its own path; no key, no reader.
  assert.deepEqual(
    await readPlainWordsPlan({ message: "Изпрати имейл до мен | Проба | Здравей", apiKey, read }),
    { type: "none" },
  );
  assert.deepEqual(await readPlainWordsPlan({ message: "прати мейл до мен", read }), { type: "none" });
  assert.equal(calls.length, 11);
});

test("the reader's email to the person runs; a missing detail asks one question; an untyped address never runs", async () => {
  const apiKey = "stand-in";
  const plan = (intent, message, turns = []) =>
    readPlainWordsPlan({ message, turns, apiKey, read: reader(intent).read });

  // „до мен“ with a text: one mail.send to the person's own address.
  assert.deepEqual(await plan(mailIntent({ recipient: "me", subject: "Здраве", body: "Тук при пост, здраве." }), "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ"), {
    type: "requests",
    requests: [
      {
        capability: "mail.send",
        action: "mail.send",
        message: "ПРАТИ МЕЛ ДА МИЯ ТУК ПРИ ПОСТ ЗДРАВЕ",
        input: { to: "", toSelf: true, subject: "Здраве", body: "Тук при пост, здраве." },
      },
    ],
  });

  // No text yet: the text is asked for; nothing runs.
  const noText = await plan(mailIntent({ recipient: "me" }), "ISKAM DA PATI MEIL DO MEN");
  assert.equal(noText.type, "ask");
  assert.match(noText.text, /^Какво да пише в имейла\?/u);

  // An address the person did not type (the reader took it from somewhere
  // else): asked, never sent.
  const untyped = await plan(mailIntent({ recipient: "ivan@example.com", recipientName: "Иван", body: "Здравей" }), "прати мейл на иван здравей");
  assert.equal(untyped.type, "ask");
  assert.match(untyped.text, /Иван/u);

  // An address the person typed in an earlier message counts.
  const typed = await plan(
    mailIntent({ recipient: "ivan@example.com", body: "Здравей" }),
    "прати му мейл здравей",
    [{ role: "user", content: "адресът на иван е ivan@example.com" }],
  );
  assert.equal(typed.type, "requests");
  assert.equal(typed.requests[0].input.to, "ivan@example.com");

  // Reading the mailbox: the reader's search words go with the request.
  assert.deepEqual(
    await plan(mailIntent({ action: "mail.read", query: "newer_than:1d" }), "каво имам в пошата днес покажи ми последните мейли"),
    {
      type: "requests",
      requests: [
        {
          capability: "mail.read",
          action: "mail.read",
          message: "каво имам в пошата днес покажи ми последните мейли",
          input: { query: "newer_than:1d" },
        },
      ],
    },
  );

  // The other tools come back as their own requests (item 3, all at once).
  assert.deepEqual(await plan(mailIntent({ action: "none" }), "покажи ми пощата"), { type: "none" });
  assert.deepEqual(await plan(mailIntent({ action: "calendar.read" }), "какво имам в календара тази седмица"), {
    type: "requests",
    requests: [{ capability: "calendar.read", action: "calendar.read", message: "какво имам в календара тази седмица" }],
  });
  assert.deepEqual(await plan(mailIntent({ action: "contacts.read", query: "Иван" }), "намери иван в контактите"), {
    type: "requests",
    requests: [{ capability: "contacts.read", action: "contacts.read", message: "Иван" }],
  });
  assert.equal((await plan(mailIntent({ action: "image.make" }), "нарисувай ми нещо")).type, "ask");
  // Someone whose Google cannot be reached here: a Google step goes on as
  // before; their own tasks still run.
  const noGoogle = (intent, message) =>
    readPlainWordsPlan({ message, apiKey, allowGoogle: false, read: reader(intent).read });
  assert.deepEqual(await noGoogle(mailIntent({ action: "contacts.read", query: "Иван" }), "намери иван в контактите"), { type: "none" });
  assert.deepEqual(await noGoogle(mailIntent({ action: "todos.read" }), "моите задачи"), {
    type: "requests",
    requests: [{ capability: "todos.read", action: "todos.read", message: "моите задачи" }],
  });
  // The reader failed: nothing changes.
  assert.deepEqual(await plan(null, "покажи ми пощата"), { type: "none" });
});

test("the reader's requests replace the detector's ones it stands in for and keep the rest", () => {
  const send = { capability: "mail.send", action: "mail.send", message: "m", input: { to: "", toSelf: true, subject: "S", body: "B" } };
  const detected = [
    { capability: "mail.read", action: "mail.read", message: "m" },
    { capability: "code.read", action: "github.read", message: "m" },
  ];
  assert.deepEqual(withPlainWordsRequests({ type: "requests", requests: [send] }, detected), [send, detected[1]]);
  assert.deepEqual(withPlainWordsRequests({ type: "none" }, detected), detected);
  assert.deepEqual(withPlainWordsRequests({ type: "ask", text: "?" }, detected), detected);
  assert.deepEqual(withPlainWordsRequests(undefined, undefined), []);
});

test("a contact or a day taken for a public search is the reader's request alone; other searches stay", () => {
  const contact = { capability: "contacts.read", action: "contacts.read", message: "Счетоводител" };
  const mail = { capability: "mail.read", action: "mail.read", message: "m" };
  const places = { capability: "places.search", action: "places.search", message: "намери телефона на счетоводителя" };
  const web = { capability: "web.search", action: "web.search", message: "m" };
  const code = { capability: "code.read", action: "github.read", message: "m" };
  assert.deepEqual(withPlainWordsRequests({ type: "requests", requests: [contact] }, [places, web, code]), [contact, code]);
  // „покажи пощата ми и намери ресторант наблизо“: both run.
  assert.deepEqual(withPlainWordsRequests({ type: "requests", requests: [mail] }, [mail, places]), [mail, places]);
});

test("an event, a contact and his own email are his own command; anything else keeps its button", () => {
  const event = { capability: "calendar.write", message: "Създай събитие: Среща с Иван | 2026-11-30 10:00 | 60" };
  const contact = { capability: "contacts.create", input: { contact: { name: "Иван", phone: "0888 123 456" } } };
  const self = { capability: "mail.send", input: { to: "", toSelf: true, subject: "S", body: "B" } };
  const untyped = { capability: "mail.send", input: { to: "ivan@example.com", subject: "S", body: "B" } };
  assert.equal(ownCommandWriteOf([{ capability: "mail.read" }, event]), event);
  assert.equal(ownCommandWriteOf([contact]), contact);
  assert.equal(ownCommandWriteOf([self]), self);
  assert.equal(ownCommandWriteOf([untyped], ["прати на иван"]), null);
  assert.equal(ownCommandWriteOf([{ capability: "calendar.delete" }, { capability: "contacts.update" }]), null);
  assert.equal(ownCommandWriteOf(null), null);
});

test("the answer after an event or a contact says what was written; a failure says why, never a made-up reason", () => {
  assert.equal(
    formatOwnWriteReply("calendar.write", "Събитието „Среща с Иван“ е записано в Google Calendar.", {
      message: "Създай събитие: Среща с Иван | 2026-11-30 10:00 | 60",
    }),
    "Събитието „Среща с Иван“ е записано в Google Calendar.\nКога: 30.11.2026 в 10:00, 60 мин.",
  );
  // A reminder has no length.
  assert.equal(
    formatOwnWriteReply("calendar.write", "", { message: "Напомни ми: Банката | 2026-11-30 09:00 | 0 минути преди" }),
    "Събитието е записано.\nКога: 30.11.2026 в 09:00.",
  );
  assert.equal(formatOwnWriteReply("contacts.create", ""), "Контактът е записан.");
  assert.equal(formatOwnWriteReply("contacts.create", "", {}, true), "The contact was saved.");
  const refused = Object.assign(new Error("task"), {
    results: [{ error: { code: "GOOGLE_SCOPE_REQUIRED", message: "Календарът няма дадено разрешение." } }],
  });
  assert.equal(ownWriteFailureReply("calendar.write", refused), "Събитието не е записано: Календарът няма дадено разрешение.");
  assert.equal(
    ownWriteFailureReply("contacts.create", Object.assign(new Error("secret detail"), { code: "TASK_WRITE_FAILED" })),
    "Контактът не е записан. Нищо не е променено; опитай пак след минута.",
  );
  assert.equal(ownWriteFailureReply("mail.send", null, true), "The email was not sent. Nothing went out; try again in a minute.");
});

test("„какво ми е деня днес“ reads the day's calendar, the open tasks and today's mail at once", async () => {
  const { read } = reader(mailIntent({ action: "calendar.read" }));
  const today = sofiaNow().date;
  const plan = await readPlainWordsPlan({ message: "какво ми е деня днес", read, apiKey: "k" });
  assert.deepEqual(
    plan.requests.map(({ capability, input }) => [capability, input || null]),
    [
      ["calendar.read", { date: today }],
      ["todos.read", null],
      ["mail.read", { query: "newer_than:1d", day: true }],
    ],
  );
  // Tomorrow: its events and the tasks; today's mail is not tomorrow's.
  const tomorrow = await readPlainWordsPlan({ message: "какво имам утре", read, apiKey: "k" });
  assert.deepEqual(
    tomorrow.requests.map(({ capability }) => capability),
    ["calendar.read", "todos.read"],
  );
  assert.notEqual(tomorrow.requests[0].input.date, today);
  // A calendar question that is not about one day stays the calendar alone.
  const week = await readPlainWordsPlan({ message: "какво имам в календара тази седмица", read, apiKey: "k" });
  assert.deepEqual(week.requests.map(({ capability }) => capability), ["calendar.read"]);
});

test("an email is the person's own command only to themselves or to an address they typed", () => {
  const mail = (input) => ({ capability: "mail.send", input });
  assert.equal(isOwnCommandEmail(mail({ to: "", toSelf: true, subject: "S", body: "B" })), true);
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", subject: "S", body: "B" }), ["прати на IVAN@example.com"]), true);
  // The address came from the assistant or a tool: it keeps „Потвърди“.
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", subject: "S", body: "B" }), ["прати на иван"]), false);
  assert.equal(isOwnCommandEmail(mail({ to: "ivan@example.com", toSelf: true }), []), false);
  assert.equal(isOwnCommandEmail(mail({ to: "not an address" }), ["not an address"]), false);
  // Not an email.
  assert.equal(isOwnCommandEmail({ capability: "calendar.write", input: { toSelf: true } }), false);
  assert.equal(isOwnCommandEmail(null), false);
});

test("the answer after the email says what went, and a failure says why in Google's words", () => {
  assert.equal(
    formatSentEmailReply("Имейлът е изпратен до ana@example.com.", { subject: "Здраве", body: "Тук при пост, здраве." }),
    "Имейлът е изпратен до ana@example.com.\nТема: Здраве\nТекст: Тук при пост, здраве.",
  );
  assert.equal(formatSentEmailReply("", {}, true), "The email was sent.");
  assert.equal(formatSentEmailReply("", { body: "x".repeat(700) }).split("\n")[1], `Текст: ${"x".repeat(599)}…`);

  const refused = Object.assign(new Error("task"), {
    results: [{ error: { code: "GOOGLE_SCOPE_REQUIRED", message: "Gmail няма дадено разрешение." } }],
  });
  assert.equal(sentEmailFailureReply(refused), "Имейлът не тръгна: Gmail няма дадено разрешение.");
  // Any other failure: no made-up reason.
  assert.equal(
    sentEmailFailureReply(Object.assign(new Error("secret detail"), { code: "TASK_WRITE_FAILED" })),
    "Имейлът не тръгна. Нищо не е изпратено; опитай пак след минута.",
  );
  assert.equal(sentEmailFailureReply(null, true), "The email was not sent. Nothing went out; try again in a minute.");
});

// The connector reads the same words; there an email is still only prepared
// for the owner's exact confirmation.
function connectorWorkspace() {
  return {
    state: {
      activeProjectId: "project-1",
      activeAgentId: "agent-1",
      projects: [{ id: "project-1", name: "Проба", objective: "", run: null }],
      agents: [{ id: "agent-1", name: "NovariumAI", role: "builder", model: "auto", purpose: "", engine: "novarium" }],
    },
  };
}

function connectorDependencies({ readWords, runTask, askAi }) {
  return {
    loadWorkspace: async () => connectorWorkspace(),
    listMemories: async () => [],
    listMessages: async () => [],
    askAi: askAi || (async () => "Отговор на модела."),
    saveTurn: async () => {},
    createSessionId: () => "mcp-plain-words",
    runTask: runTask || (async () => ({ results: [], requests: [] })),
    getGoogleSession: async () => "google-session",
    getGitHubSession: async () => null,
    auditTask: async () => {},
    readWords,
  };
}

test("the connector reads his mail words: the mailbox runs with Google, and a missing detail asks", async () => {
  const owner = { role: "owner", displayName: "Радко" };
  let taskOptions;
  const read = { capability: "mail.read", action: "mail.read", message: "каво имам в пошата", input: { query: "newer_than:1d" } };
  const result = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "каво имам в пошата днес покажи ми последните мейли", identity: owner },
    connectorDependencies({
      readWords: async ({ message, turns }) => {
        assert.equal(message, "каво имам в пошата днес покажи ми последните мейли");
        assert.deepEqual(turns, []);
        return { type: "requests", requests: [read] };
      },
      runTask: async (options) => {
        taskOptions = options;
        return {
          requests: [read],
          results: [
            {
              status: "fulfilled",
              request: read,
              result: { output: "Последни съобщения в Gmail:\n• Проба — ana@example.com", requiresConfirmation: false },
            },
          ],
          task: { id: "task-1", status: "completed", verified: true },
          plannerUsed: false,
        };
      },
    }),
  );
  assert.deepEqual(taskOptions.fallbackRequests, [read]);
  assert.equal(taskOptions.planningAllowed, false);
  assert.equal(taskOptions.executionContext.googleSessionId, "google-session");
  // A write is still only prepared on the connector.
  assert.equal(taskOptions.executionContext.prepareConfirmation, true);
  assert.match(result.response, /Последни съобщения в Gmail/u);

  const asked = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "ISKAM DA PATI MEIL DO MEN", identity: owner },
    connectorDependencies({
      readWords: async () => ({ type: "ask", text: "Какво да пише в имейла? Напиши текста и го пращам веднага." }),
      runTask: async () => assert.fail("nothing runs before the text is there"),
      askAi: async () => assert.fail("the question is the answer"),
    }),
  );
  assert.equal(asked.response, "Какво да пише в имейла? Напиши текста и го пращам веднага.");
  assert.deepEqual(asked.capabilities, []);

  // „Don't use tools“ is kept: the reader is not asked.
  await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "Разкажи ми за пощата, без да използваш инструменти", identity: owner },
    connectorDependencies({ readWords: async () => assert.fail("no tools were asked for") }),
  );
});

// „Разкачи“ in „Инструменти“ (review S6): no question about a tool the
// person turned off; the message goes on to the model, which says so.
test("the reader asks nothing and plans nothing for a tool the person turned off", async () => {
  const apiKey = "stand-in";
  const plan = (intent, message, capabilitiesOff) =>
    readPlainWordsPlan({ message, apiKey, read: reader(intent).read, capabilitiesOff });
  const gmailOff = new Set(["mail.read", "mail.search", "mail.draft", "mail.send", "mail.delete"]);

  // With Gmail on, the address is asked; with Gmail off, nothing.
  assert.equal((await plan(mailIntent({ recipientName: "Иван" }), "прати имейл на иван", new Set())).type, "ask");
  assert.deepEqual(await plan(mailIntent({ recipientName: "Иван" }), "прати имейл на иван", gmailOff), { type: "none" });
  assert.deepEqual(await plan(mailIntent({ action: "mail.read" }), "покажи ми пощата", gmailOff), { type: "none" });
  // A reminder is a calendar write.
  assert.deepEqual(
    await plan(mailIntent({ action: "calendar.reminder", title: "банката" }), "напомни ми за банката", new Set(["calendar.write"])),
    { type: "none" },
  );
  assert.deepEqual(await plan(mailIntent({ action: "todos.add" }), "добави задача", new Set(["todos.read", "todos.add"])), {
    type: "none",
  });
  // Another tool still runs.
  assert.equal((await plan(mailIntent({ action: "calendar.read" }), "какво имам в календара днес", gmailOff)).type, "requests");
  // The switches could not be read: every tool is out, nothing is asked.
  const unreadable = new Set([...gmailOff, "calendar.read", "calendar.write", "todos.read", "todos.add"]);
  unreadable.unavailable = true;
  assert.deepEqual(await plan(mailIntent({ action: "calendar.read" }), "какво имам в календара днес", unreadable), {
    type: "none",
  });
});

test("a calendar, code or GitHub step prepared before its tool was turned off is refused when confirmed", async () => {
  const { switchedOffConfirmation } = await import("../src/routes/chat.js");
  const { capabilitiesOfTools } = await import("../src/services/toolSwitchService.js");
  assert.equal(switchedOffConfirmation({ calendar: true }, new Set()), null);
  assert.equal(switchedOffConfirmation({}, capabilitiesOfTools(["google-calendar-write"])), null);
  assert.equal(switchedOffConfirmation({ calendar: true }, capabilitiesOfTools(["gmail-read"])), null);

  const calendar = switchedOffConfirmation({ calendar: true }, capabilitiesOfTools(["google-calendar-write"]));
  assert.equal(calendar.code, "TOOL_SWITCHED_OFF");
  assert.match(calendar.error, /разкачен в „Инструменти“.*„Свържи“/u);
  assert.equal(switchedOffConfirmation({ codeTask: true }, capabilitiesOfTools(["github-write"])).code, "TOOL_SWITCHED_OFF");
  assert.equal(switchedOffConfirmation({ codeTask: true }, capabilitiesOfTools(["github-confirmed-write"])), null);
  assert.equal(
    switchedOffConfirmation({ githubChange: true }, capabilitiesOfTools(["github-confirmed-write"])).code,
    "TOOL_SWITCHED_OFF",
  );
  assert.match(
    switchedOffConfirmation({ githubChange: true }, capabilitiesOfTools(["github-confirmed-write"]), true).error,
    /turned off in “Tools”/u,
  );

  const unreadable = capabilitiesOfTools(["google-calendar-write"]);
  unreadable.unavailable = true;
  const paused = switchedOffConfirmation({ calendar: true }, unreadable);
  assert.match(paused.error, /не се прочетоха/u);
  assert.doesNotMatch(paused.error, /разкачен/u);
});
