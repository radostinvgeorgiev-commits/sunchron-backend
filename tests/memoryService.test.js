import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContext,
  consolidateMemoryView,
  deriveMemoryMetadata,
  extractForgetMemoryCommand,
  extractImplicitMemoryCandidates,
  isConfirmedForgetAllCommand,
  isForgetAllCommand,
  extractPersistentMemoryCommand,
} from "../src/services/memoryService.js";

test("a correction replaces the same personal preference topic", () => {
  const oldFact = deriveMemoryMetadata("Любимият ми цвят е син");
  const correctedFact = deriveMemoryMetadata("Любимият ми цвят вече е зелен");

  assert.equal(oldFact.memoryKey, "personal:preference:favorite-color");
  assert.equal(correctedFact.memoryKey, oldFact.memoryKey);
});

test("residence facts use one stable key across wording changes", () => {
  assert.equal(
    deriveMemoryMetadata("Живея във Варна").memoryKey,
    deriveMemoryMetadata("Местоживеенето ми е Варна").memoryKey,
  );
});

test("project facts are separated from personal facts", () => {
  const command = extractPersistentMemoryCommand(
    "Запомни за проекта: текущата цел на проекта е стабилен AI разговор.",
  );

  assert.deepEqual(command, {
    fact: "текущата цел на проекта е стабилен AI разговор",
    scope: "project",
  });
  assert.equal(
    deriveMemoryMetadata(command.fact, command.scope).memoryKey,
    "project:goal:current",
  );
});

test("personal correction and project deletion commands preserve scope", () => {
  assert.deepEqual(
    extractPersistentMemoryCommand(
      "Поправка: любимият ми цвят вече е зелен. Запомни това.",
    ),
    {
      fact: "любимият ми цвят вече е зелен",
      scope: "personal",
    },
  );
  assert.deepEqual(
    extractForgetMemoryCommand(
      "Изтрий за проекта: текущата цел на проекта е стабилен AI разговор.",
    ),
    {
      fact: "текущата цел на проекта е стабилен AI разговор",
      scope: "project",
    },
  );
});

test("parses natural commands that delete only one permanent-memory fact", () => {
  assert.deepEqual(
    extractForgetMemoryCommand(
      "Изтрий от постоянната памет само: Тестова дума — МОРСКИ ФАР 728",
    ),
    {
      fact: "Тестова дума — МОРСКИ ФАР 728",
      scope: "personal",
    },
  );
  assert.deepEqual(
    extractForgetMemoryCommand(
      "Изтрий от постоянната памет само на факта: Тестова дума — МОРСКИ ФАР 728",
    ),
    {
      fact: "Тестова дума — МОРСКИ ФАР 728",
      scope: "personal",
    },
  );
});

test("memory context labels personal and project facts separately", () => {
  const context = buildMemoryContext([
    { fact: "Живея във Варна", scope: "personal" },
    {
      fact: "Текущата цел на проекта е стабилен AI разговор",
      scope: "project",
    },
  ]);

  assert.match(context, /\[ЛИЧЕН ПРОФИЛ НА РАДКО\][\s\S]*Живея във Варна/);
  assert.match(
    context,
    /\[КОНТЕКСТ НА ПРОЕКТА\][\s\S]*Текущата цел на проекта е стабилен AI разговор/,
  );
  assert.match(context, /избира най-подходящия AI модел/u);
});

test("canonical project definition replaces an obsolete avatar-only goal in context", () => {
  const context = buildMemoryContext([
    {
      fact: "Текущата цел е работещ личен AI аватар",
      scope: "project",
    },
  ]);

  assert.match(context, /SYNCHRON-X е лична AI операционна система/u);
  assert.doesNotMatch(
    context,
    /\[КОНТЕКСТ НА ПРОЕКТА\][\s\S]*Текущата цел е работещ личен AI аватар/u,
  );
});

test("extracts clear personal facts from a normal conversation message", () => {
  assert.deepEqual(
    extractImplicitMemoryCandidates(
      "Имам бунгала в Камчия и се интересувам от къмпинги, каравани и туризъм.",
    ),
    [
      {
        fact: "Имам бунгала в Камчия",
        scope: "personal",
        confidence: "high",
      },
      {
        fact: "се интересувам от къмпинги, каравани и туризъм",
        scope: "personal",
        confidence: "high",
      },
    ],
  );
});

test("does not turn questions or casual topics into permanent memories", () => {
  assert.deepEqual(
    extractImplicitMemoryCandidates("Как се прави къмпинг край морето?"),
    [],
  );
  assert.deepEqual(
    extractImplicitMemoryCandidates("Разкажи ми за каравани."),
    [],
  );
});

test("explicit memory commands are not duplicated as automatic memories", () => {
  assert.deepEqual(
    extractImplicitMemoryCandidates(
      "Запомни: интересувам се от къмпинги и каравани.",
    ),
    [],
  );
});

test("implicit interests receive a structured interest category", () => {
  const metadata = deriveMemoryMetadata(
    "Се интересувам от къмпинги и каравани",
  );
  assert.equal(metadata.category, "interest");
  assert.match(metadata.memoryKey, /^personal:interest:/u);
});

test("consolidates overlapping interests without deleting source memories", () => {
  const items = consolidateMemoryView([
    {
      id: "new",
      fact: "Се интересувам от история и пътувания",
      category: "interest",
      scope: "personal",
      updatedAt: "2026-07-24T21:00:00.000Z",
    },
    {
      id: "old",
      fact: "се интересувам от къмпинги, каравани и туризъм",
      category: "interest",
      scope: "personal",
      updatedAt: "2026-07-24T20:00:00.000Z",
    },
    {
      id: "shop",
      fact: "Имам магазин във Варна",
      category: "work",
      scope: "personal",
    },
  ]);

  assert.equal(items.length, 2);
  assert.equal(
    items[0].fact,
    "Интересувам се от история, пътувания, къмпинги, каравани, туризъм",
  );
  assert.equal(items[1].fact, "Имам магазин във Варна");
});

test("classifies different businesses as separate work memories", () => {
  const shop = deriveMemoryMetadata("Имам магазин във Варна");
  const bungalows = deriveMemoryMetadata("Имам бунгала в Камчия");

  assert.equal(shop.category, "work");
  assert.equal(bungalows.category, "work");
  assert.notEqual(shop.memoryKey, bungalows.memoryKey);
});

test("splits and deduplicates legacy profile lists without deleting history", () => {
  const items = consolidateMemoryView([
    {
      id: "new-location",
      fact: "живея във Варна.",
      category: "location",
      memoryKey: "personal:location:residence",
      scope: "personal",
    },
    {
      id: "new-work",
      fact: "имам бизнес с бунгала в Камчия.",
      category: "work",
      memoryKey: "personal:work:bизнес-с-бунгала",
      scope: "personal",
    },
    {
      id: "legacy",
      fact: "- Казвам се Радко. - Живея във Варна. - Имам бизнес с бунгала в Камчия",
      category: "personal-fact",
      memoryKey: "personal:fact:legacy",
      scope: "personal",
    },
  ]);

  assert.deepEqual(
    items.map((item) => item.fact),
    ["живея във Варна", "имам бизнес с бунгала в Камчия", "Казвам се Радко"],
  );
  assert.equal(
    items.some((item) => item.fact.startsWith("-")),
    false,
  );
});

test("full memory deletion requires a separate explicit confirmation phrase", () => {
  assert.equal(isForgetAllCommand("Изтрий цялата постоянна памет."), true);
  assert.equal(
    isConfirmedForgetAllCommand(
      "Потвърждавам изтриването на цялата постоянна памет.",
    ),
    true,
  );
  assert.equal(isConfirmedForgetAllCommand("Да, изтрий я."), false);
});

// ── New tests covering fix for issue #81 ────────────────────────────────────

test("'моят X е VALUE' facts get a topic-based key without the value", () => {
  const m1 = deriveMemoryMetadata("моят тестов код е KAMCHIA-7429");
  assert.equal(m1.memoryKey, "personal:property:моят-тестов-код");

  const m2 = deriveMemoryMetadata("моят тестов код е МОРСКИ ФАР 728");
  assert.equal(m2.memoryKey, "personal:property:моят-тестов-код");

  // Both should share the same key so the newer value supersedes the older
  assert.equal(m1.memoryKey, m2.memoryKey);
});

test("'моята X е VALUE' and 'моето X е VALUE' also use a topic-based key", () => {
  assert.equal(
    deriveMemoryMetadata("моята любима книга е Дюн").memoryKey,
    "personal:property:моят-любима-книга",
  );
  assert.equal(
    deriveMemoryMetadata("моето хоби е плуване").memoryKey,
    "personal:property:моят-хоби",
  );
});

test("'моят X е VALUE' key is distinct from an unrelated 'тестова дума' key", () => {
  const testCode = deriveMemoryMetadata("моят тестов код е KAMCHIA-7429");
  const testWord = deriveMemoryMetadata("тестова дума — МОРСКИ ФАР 728");

  assert.notEqual(testCode.memoryKey, testWord.memoryKey);
});

test("existing patterns are not affected by the new 'моят' rule", () => {
  // Location key is still derived from "живея"
  assert.equal(
    deriveMemoryMetadata("Живея в София").memoryKey,
    "personal:location:residence",
  );
  // Preference key still works for "любимият ми цвят"
  assert.equal(
    deriveMemoryMetadata("Любимият ми цвят е червен").memoryKey,
    "personal:preference:favorite-color",
  );
});

test("memory context includes anti-confusion instruction for different fact names", () => {
  const context = buildMemoryContext([
    { fact: "моят тестов код е KAMCHIA-7429", scope: "personal" },
    { fact: "Тестова дума — МОРСКИ ФАР 728", scope: "personal" },
  ]);

  // Both facts should appear
  assert.match(context, /KAMCHIA-7429/);
  assert.match(context, /МОРСКИ ФАР 728/);

  // The anti-confusion instruction must be present
  assert.match(context, /тестова дума.*тестов код.*РАЗЛИЧНИ факти/u);
});

test("memory context includes honest-answer instruction for missing facts", () => {
  const context = buildMemoryContext([
    { fact: "Живея в Варна", scope: "personal" },
  ]);

  assert.match(context, /Не знам/u);
});

test("consolidateMemoryView keeps only newest when two entries share the same 'моят X' key", () => {
  const items = consolidateMemoryView([
    {
      id: "new",
      fact: "моят тестов код е KAMCHIA-7429",
      memoryKey: "personal:property:моят-тестов-код",
      category: "personal-fact",
      scope: "personal",
      updatedAt: "2026-07-28T12:00:00.000Z",
    },
    {
      id: "old",
      fact: "моят тестов код е МОРСКИ ФАР 728",
      memoryKey: "personal:property:моят-тестов-код",
      category: "personal-fact",
      scope: "personal",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  // Only the newer entry should survive deduplication
  assert.equal(items.length, 1);
  assert.match(items[0].fact, /KAMCHIA-7429/);
  assert.doesNotMatch(items[0].fact, /МОРСКИ ФАР/);
});
