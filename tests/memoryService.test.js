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
