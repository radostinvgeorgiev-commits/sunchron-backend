import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilityReplies,
  buildMemoryReply,
  detectCapabilityRequests,
  executeDetectedCapabilities,
  extractConfirmedMemoryDeleteCommand,
  mergeMemoryTaskStatus,
  mergeCapabilityRequests,
  shouldReplyWithVerifiedToolOutput,
  splitCapabilitySubtasks,
} from "../src/routes/chat.js";
import { extractMemoryWriteConfirmationId } from "../src/services/memoryWriteConfirmationService.js";

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

test("routes a new calendar event only to confirmed Calendar Write", () => {
  const message = "Създай събитие: Среща | 2026-08-05 14:30 | 60";
  const requests = detectCapabilityRequests(message);
  assert.deepEqual(
    requests.map(({ capability, action }) => ({ capability, action })),
    [{ capability: "calendar.write", action: "calendar.write" }],
  );
  assert.equal(requests[0].message, message);
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

test("общ въпрос за инструментите задейства реална системна проверка", () => {
  for (const message of [
    "А инструментите работят ли?",
    "Кои връзки са активни?",
    "Покажи статус на интеграциите.",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability }) => capability),
      ["system.integrations.status"],
    );
  }
});

test("проверка на сървърните променливи използва защитения системен контрол", () => {
  for (const message of [
    "Провери всички променливи на сървъра.",
    "Покажи конфигурацията на ядрото и DigitalOcean.",
    "Виж environment настройките на системата.",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability }) => capability),
      ["system.configuration.read"],
    );
  }
});

test("въпрос дали GitHub може да пише минава през реалния статус на Copilot моста", () => {
  for (const message of [
    "Демек вече може да пише в хъба и да комитва?",
    "Работи ли GitHub Write мостът за branch, commit и Pull Request?",
    "Има ли активен инструмент за писане в GitHub?",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability }) => capability),
      ["system.integrations.status"],
    );
  }
});

test("конкретна Copilot задача се проследява през отделна read-only способност", () => {
  for (const message of [
    "Провери статуса на GitHub задача #83.",
    "Докъде е Copilot issue 83?",
    "Какво става с PR #146?",
  ]) {
    assert.deepEqual(
      detectCapabilityRequests(message).map(({ capability, action }) => ({
        capability,
        action,
      })),
      [{ capability: "code.task-status", action: "github.read" }],
    );
  }
});

test("въпрос за Tool Registry остава GitHub проверка, а не системен статус", () => {
  assert.deepEqual(
    detectCapabilityRequests(
      "Провери в GitHub кои инструменти са регистрирани в Tool Registry.",
    ).map(({ capability }) => capability),
    ["code.read"],
  );
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
        request: { capability: "code.task-status" },
        result: { output: "Проверен GitHub статус." },
      },
    ]),
    true,
  );
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
    confirmationId: "123e4567-e89b-12d3-a456-426614174000",
    items: [{ fact: "трябва да пуснем деплой след merge" }],
  });
  assert.match(memoryReply, /още не съм записал нищо/u);
  assert.match(
    memoryReply,
    /Потвърждавам постоянен запис: 123e4567-e89b-12d3-a456-426614174000/u,
  );

  const fullReply = [memoryReply, ...capabilityReplies].join("\n\n");
  assert.match(fullReply, /Result 1/u);
  assert.match(fullReply, /Result 5/u);
  assert.match(fullReply, /потвърждение/iu);

  assert.equal(
    extractMemoryWriteConfirmationId(
      "Запомни, че трябва да пуснем деплой след merge.",
    ),
    null,
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

test("accepts only the exact one-time memory-write confirmation", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    extractMemoryWriteConfirmationId(`Потвърждавам постоянен запис: ${id}`),
    id,
  );
  assert.equal(
    extractMemoryWriteConfirmationId(
      "Потвърждавам запис в постоянната памет: проектът е SYNCHRON-X",
    ),
    null,
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
  assert.equal(
    extractMemoryWriteConfirmationId(
      "Потвърждавам запис в постоянната памет: На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine.",
    ),
    null,
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
    [
      "code.read",
      "calendar.read",
      "memory.read",
      "web.search",
      "system.integrations.status",
    ],
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
    ["code.read", "system.integrations.status", "code.write"],
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
