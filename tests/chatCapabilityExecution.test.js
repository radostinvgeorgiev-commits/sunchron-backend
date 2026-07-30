import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilityReplies,
  buildMemoryReply,
  detectCapabilityRequests,
  executeDetectedCapabilities,
  extractConfirmedMemoryDeleteCommand,
  extractConfirmedMemoryWriteCommands,
  mergeMemoryTaskStatus,
  mergeCapabilityRequests,
  shouldReplyWithVerifiedToolOutput,
  splitCapabilitySubtasks,
} from "../src/routes/chat.js";

test("memory confirmation keeps the overall task waiting", () => {
  const task = {
    id: "task-1",
    status: "completed",
    verified: true,
    totalSteps: 0,
  };
  const waiting = mergeMemoryTaskStatus(task, {
    type: "write-confirmation-required",
  });

  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(waiting.verified, false);
});

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

test("detects an explicit autonomous permanent-memory test", () => {
  const requests = detectCapabilityRequests(
    "Тествай сам и реално постоянната памет.",
  );

  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [{ capability: "memory.verify", action: "memory.test" }],
  );
});

test("a normal memory check remains read-only", () => {
  const requests = detectCapabilityRequests("Провери паметта.");

  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [{ capability: "memory.read", action: "memory.read" }],
  );
});

test("recognizes common Bulgarian GitHub spellings as a real tool request", () => {
  for (const message of [
    "Провери ГитХъб.",
    "Провери гит хъб.",
    "Провери хъба.",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability }) => capability),
      ["code.read"],
    );
  }
});

test("routes safe merged-branch cleanup planning from chat to GitHub Read", () => {
  const message =
    "Подготви безопасен списък за изтриване само на GitHub клоновете от вече слети PR-и. Не изтривай нищо.";
  const requests = detectCapabilityRequests(message);

  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [{ capability: "code.read", action: "github.read" }],
  );
});

test("разпознава изрична проверка на Supabase", () => {
  assert.deepEqual(
    detectCapabilityRequests("Провери дали Supabase е свързан и работи.").map(
      ({ capability, action }) => ({ capability, action }),
    ),
    [{ capability: "database.status", action: "database.read" }],
  );
});

test("recognizes common Bulgarian DigitalOcean spellings as real tool requests", () => {
  for (const message of [
    "Направи реален одит на Дигитал Океан.",
    "Провери целия Дижитал Океан акаунт.",
    "Направи одит на Дижитал Окан.",
    "Покажи ресурсите в Digital Ocean.",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability }) => capability),
      ["infrastructure.digitalocean.read"],
    );
  }
});

test("infrastructure results bypass AI rewriting and stay verified", () => {
  assert.equal(
    shouldReplyWithVerifiedToolOutput([
      {
        status: "fulfilled",
        request: { capability: "infrastructure.digitalocean.read" },
        result: { output: "Проверен DigitalOcean доклад." },
      },
    ]),
    true,
  );
  assert.equal(
    shouldReplyWithVerifiedToolOutput([
      {
        status: "fulfilled",
        request: { capability: "code.read" },
        result: { output: "GitHub result" },
      },
    ]),
    false,
  );
});

test("deterministic tool requests survive an empty or weaker AI plan", () => {
  const fallback = [
    {
      capability: "code.read",
      action: "github.read",
      message: "Провери GitHub.",
    },
  ];

  assert.deepEqual(mergeCapabilityRequests(fallback, []), fallback);
  assert.deepEqual(
    mergeCapabilityRequests(fallback, [
      {
        capability: "code.read",
        action: "github.read",
        message: "Провери последния commit.",
      },
      {
        capability: "calendar.read",
        action: "calendar.read",
        message: "Провери календара.",
      },
    ]),
    [
      ...fallback,
      {
        capability: "calendar.read",
        action: "calendar.read",
        message: "Провери календара.",
      },
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
  assert.match(memoryReply, /Потвърждение за запис в постоянната памет/u);
  assert.match(
    memoryReply,
    /Потвърждавам запис в постоянната памет: трябва да пуснем деплой/u,
  );

  const fullReply = [memoryReply, ...capabilityReplies].join("\n\n");
  assert.match(fullReply, /Result 1/u);
  assert.match(fullReply, /Result 5/u);
  assert.match(fullReply, /потвърждение/iu);

  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Запомни, че трябва да пуснем деплой след merge.",
    ),
    [],
  );
});

test("collapses identical tool outputs into one visible reply", () => {
  const request = {
    capability: "code.read",
    action: "github.read",
    message: "Провери последната промяна в GitHub.",
  };
  const repeatedOutput = [
    "Последната реална промяна в GitHub е:",
    "• 691cc3c — Поправка на агентските задачи и опростяване на интерфейса (#53)",
  ].join("\n");
  const results = Array.from({ length: 5 }, () => ({
    status: "fulfilled",
    request,
    result: {
      output: repeatedOutput,
      tool: { id: "github-read", name: "GitHub Read" },
    },
  }));

  const replies = buildCapabilityReplies(results);

  assert.equal(replies.length, 2);
  assert.equal(replies[0], repeatedOutput);
  assert.match(replies[1], /Използвани инструменти/u);
  assert.equal(
    replies.join("\n").split("Последната реална промяна в GitHub е:").length -
      1,
    1,
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

test("requires an explicit confirmation before deleting one memory", () => {
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
  assert.deepEqual(
    extractConfirmedMemoryDeleteCommand(
      "Потвърждавам изтриването от постоянната памет само на факта: Тестова дума — МОРСКИ ФАР 728",
    ),
    {
      fact: "Тестова дума — МОРСКИ ФАР 728",
      scope: "personal",
    },
  );
  assert.deepEqual(
    extractConfirmedMemoryDeleteCommand(
      "Потвърждавам изтриването от постоянната ми памет само: Тестова дума — МОРСКИ ФАР 728",
    ),
    {
      fact: "Тестова дума — МОРСКИ ФАР 728",
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
  const statusLines = buildCapabilityReplies(
    requests.map((request) => ({
      status: "fulfilled",
      request,
      result: {
        output: "ok",
        tool: { id: "github-read", name: "GitHub Read" },
      },
    })),
  )
    .at(-1)
    .split("\n")
    .filter((line) => /GitHub Read/u.test(line));
  assert.equal(statusLines.length, 1);
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

  const requests = detectCapabilityRequests(message);
  assert.deepEqual(
    requests.map(({ capability }) => capability),
    ["code.read", "calendar.read", "memory.read", "web.search"],
  );
  assert.equal(
    requests.filter(({ capability }) => capability === "code.read").length,
    1,
  );
  assert.equal(
    requests.find(({ capability }) => capability === "memory.read").scope,
    "project",
  );
});

test("a GitHub implementation task creates one read check and one honest write attempt", () => {
  const message = [
    "Работи по GitHub хранилището radostinvgeorgiev-commits/sunchron-backend.",
    "1. Провери актуалния main и сегашния интерфейс.",
    "2. Провери кои инструменти действително работят.",
    "3. Обнови интерфейса и скрий неактуалните функции.",
    "4. Не променяй AI Core и Memory.",
    "5. Използвай само свързаното GitHub приложение.",
    "6. Направи промяната в отделен клон.",
    "7. Пусни тестовете.",
    "8. Създай Pull Request и го слей в main.",
    "9. Провери deployment.",
  ].join("\n");

  const requests = detectCapabilityRequests(message);
  assert.deepEqual(
    requests.map(({ capability }) => capability),
    ["code.read", "code.write"],
  );
  assert.equal(
    requests.filter(({ capability }) => capability === "code.read").length,
    1,
  );
  assert.equal(
    requests.filter(({ capability }) => capability === "code.write").length,
    1,
  );
});
