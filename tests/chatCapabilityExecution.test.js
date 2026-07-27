import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilityReplies,
  buildMemoryReply,
  detectCapabilityRequests,
  executeDetectedCapabilities,
  extractConfirmedMemoryDeleteCommand,
  extractConfirmedMemoryWriteCommands,
  splitCapabilitySubtasks,
} from "../src/routes/chat.js";

test("detects multiple capability subtasks in one message", () => {
  const requests = detectCapabilityRequests(
    "Провери календара и GitHub commit-ите от днес.",
  );
  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [
      { capability: "calendar.read", action: "calendar.read" },
      { capability: "code.read", action: "github.read" },
    ],
  );
});

test("splits a complex command into independent subtasks", () => {
  const subtasks = splitCapabilitySubtasks(
    "1) Провери GitHub последните commit-и; 2) Провери GitHub подробностите за последния commit.\n3) Провери GitHub кои файлове са пипани.",
  );
  assert.deepEqual(subtasks, [
    "Провери GitHub последните commit-и",
    "Провери GitHub подробностите за последния commit.",
    "Провери GitHub кои файлове са пипани.",
  ]);
});

test("executes all detected subtasks sequentially even after a failure", async () => {
  const calls = [];
  const results = await executeDetectedCapabilities(
    "Провери календара и GitHub.",
    async (capability, _options) => {
      calls.push(capability);
      if (capability === "calendar.read") {
        throw new Error("calendar temporary failure");
      }
      return {
        output: "GitHub result",
        permission: { decision: "allow" },
        tool: { id: "github-read" },
      };
    },
  );

  assert.deepEqual(calls, ["calendar.read", "code.read"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].error.message, "calendar temporary failure");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].result.output, "GitHub result");
});

test("complex 5-check command runs all checks, merges results, and asks memory-write confirmation", async () => {
  const message = [
    "Провери GitHub последните commit-и;",
    "Провери GitHub подробности за последния commit;",
    "Провери GitHub променените файлове;",
    "Провери GitHub историята за днес;",
    "Провери GitHub последната реална промяна;",
    "Запомни, че трябва да пуснем деплой след merge.",
  ].join(" ");

  const calls = [];
  const results = await executeDetectedCapabilities(
    message,
    async (capability, options) => {
      calls.push({ capability, message: options.message });
      return {
        output: `Result ${calls.length}: ${options.message}`,
        permission: { decision: "allow" },
        tool: { id: "github-read" },
      };
    },
  );

  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map((call) => call.capability),
    ["code.read", "code.read", "code.read", "code.read", "code.read"],
  );

  const capabilityReplies = buildCapabilityReplies(results);
  assert.equal(capabilityReplies.length, 6);
  assert.match(capabilityReplies[0], /Result 1/u);
  assert.match(capabilityReplies[4], /Result 5/u);
  assert.match(capabilityReplies[5], /Използвани инструменти/u);

  const memoryReply = buildMemoryReply({
    type: "write-confirmation-required",
    items: [{ fact: "трябва да пуснем деплой след merge" }],
  });
  assert.match(memoryReply, /Искаш запис в постоянната памет/u);
  assert.match(memoryReply, /За потвърждение изпрати точно/u);

  const fullReply = [memoryReply, ...capabilityReplies].join("\n\n");
  assert.match(fullReply, /Result 1/u);
  assert.match(fullReply, /Result 5/u);
  assert.match(fullReply, /потвърждение/u);

  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Запомни, че трябва да пуснем деплой след merge.",
    ),
    [],
  );
});

test("requires explicit memory-write confirmation prefix", () => {
  const commands = extractConfirmedMemoryWriteCommands(
    "Потвърждавам запис в постоянната памет: Запомни, че проектът е SYNCHRON-X.",
  );
  assert.deepEqual(commands, [
    { fact: "проектът е SYNCHRON-X", scope: "personal" },
  ]);
  assert.deepEqual(
    extractConfirmedMemoryWriteCommands("Запомни, че проектът е SYNCHRON-X."),
    [],
  );
});

test("requires an exact confirmation prefix before deleting one memory", () => {
  assert.equal(
    extractConfirmedMemoryDeleteCommand(
      "Изтрий от паметта: любимият ми цвят е син.",
    ),
    null,
  );
  assert.deepEqual(
    extractConfirmedMemoryDeleteCommand(
      "Потвърждавам изтриване от постоянната памет: любимият ми цвят е син.",
    ),
    {
      fact: "любимият ми цвят е син",
      scope: "personal",
    },
  );
});

test("splits and detects the real one-line five-check GitHub command without treating memory as GitHub", () => {
  const message =
    "Провери актуалния main на GitHub хранилището radostinvgeorgiev-commits/sunchron-backend. Намери: 1. Къде са Tool Registry и Capability Engine. 2. Кои инструменти са регистрирани. 3. Какви разрешения изисква всеки инструмент. 4. Дали чатът действително използва Capability Engine. 5. Кои са трите последно поправени проблема. Не променяй никакъв файл. Накрая запомни в постоянната ми памет: „На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine.“ Преди запис в паметта поискай моето потвърждение.";

  const requests = detectCapabilityRequests(message);
  assert.equal(requests.length, 5);
  assert.deepEqual(
    requests.map(({ message: subtask }) => subtask),
    [
      "Къде са Tool Registry и Capability Engine.",
      "Кои инструменти са регистрирани.",
      "Какви разрешения изисква всеки инструмент.",
      "Дали чатът действително използва Capability Engine.",
      "Кои са трите последно поправени проблема.",
    ],
  );
  assert.equal(
    requests.some(({ message: subtask }) => /запомни/iu.test(subtask)),
    false,
  );
  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Потвърждавам запис в постоянната памет: На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine.",
    ),
    [
      {
        fact: "На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine",
        scope: "personal",
      },
    ],
  );
});

test("detects a combined personal-OS tool check without duplicate GitHub tasks", () => {
  const message = [
    "Провери последния commit в GitHub.",
    "Покажи събитията ми в календара за утре.",
    "Провери какво помниш за проекта SYNCHRON-X.",
    "Провери актуалното време във Варна.",
    "Кажи кои инструменти използва успешно и кои не са достъпни.",
  ].join(" ");

  assert.deepEqual(
    detectCapabilityRequests(message).map(({ capability }) => capability),
    ["code.read", "calendar.read", "memory.read", "web.search"],
  );
});
