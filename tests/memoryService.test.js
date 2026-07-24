import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContext,
  deriveMemoryMetadata,
  extractForgetMemoryCommand,
  extractPersistentMemoryCommand,
} from "../src/services/memoryService.js";

test("a correction replaces the same personal preference topic", () => {
  const oldFact = deriveMemoryMetadata("Любимият ми цвят е син");
  const correctedFact = deriveMemoryMetadata(
    "Любимият ми цвят вече е зелен",
  );

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
});
