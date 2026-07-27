import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPersistentMemoryCommand,
  extractPersistentMemoryCommands,
} from "../src/services/memoryService.js";

test("parses a multiline personal profile into separate memories", () => {
  assert.deepEqual(
    extractPersistentMemoryCommands(`Запомни следното за мен:
- Казвам се Радко.
- Живея във Варна.
- Имам бизнес с бунгала в Камчия.`),
    [
      { fact: "Казвам се Радко", scope: "personal" },
      { fact: "Живея във Варна", scope: "personal" },
      { fact: "Имам бизнес с бунгала в Камчия", scope: "personal" },
    ],
  );
});

test("parses numbered project context into separate project memories", () => {
  assert.deepEqual(
    extractPersistentMemoryCommands(`Запомни следното за проекта:
1. Проектът се казва SYNCHRON-X.
2. Текущата цел на проекта е стабилен AI разговор.`),
    [
      { fact: "Проектът се казва SYNCHRON-X", scope: "project" },
      {
        fact: "Текущата цел на проекта е стабилен AI разговор",
        scope: "project",
      },
    ],
  );
});

test("supports semicolon-separated bulk memories", () => {
  assert.deepEqual(
    extractPersistentMemoryCommands(
      "Запомни следното: Живея във Варна; Имам бизнес в Камчия.",
    ),
    [
      { fact: "Живея във Варна", scope: "personal" },
      { fact: "Имам бизнес в Камчия", scope: "personal" },
    ],
  );
});

test("keeps backward compatibility with one correction command", () => {
  const message = "Поправка: любимият ми цвят вече е зелен. Запомни това.";
  assert.deepEqual(extractPersistentMemoryCommands(message), [
    extractPersistentMemoryCommand(message),
  ]);
});

test("extracts an embedded memory request from a complex command", () => {
  const message =
    "Провери петте GitHub точки. Накрая запомни в постоянната ми памет: „На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine.“ Преди запис в паметта поискай моето потвърждение.";
  assert.deepEqual(extractPersistentMemoryCommands(message), [
    {
      fact: "На 27 юли 2026 г. проверихме връзката между чата, GitHub и Capability Engine",
      scope: "personal",
    },
  ]);
});
