import assert from "node:assert/strict";
import test from "node:test";

import { extractMemoryCandidates } from "../src/services/memoryCandidateService.js";

test("proposes direct personal and project facts without writing them", () => {
  assert.deepEqual(
    extractMemoryCandidates({
      userText:
        "Казвам се Радко. Предпочитам кратки отговори. Текущата цел на проекта е стабилен AI разговор.",
      assistantText: "Разбрах.",
    }),
    [
      {
        fact: "Казвам се Радко",
        scope: "personal",
        category: "identity",
        reason:
          "Изглежда като устойчив факт, който може да помогне в бъдещи разговори.",
      },
      {
        fact: "Предпочитам кратки отговори",
        scope: "personal",
        category: "preference",
        reason:
          "Изглежда като устойчив факт, който може да помогне в бъдещи разговори.",
      },
      {
        fact: "Текущата цел на проекта е стабилен AI разговор",
        scope: "project",
        category: "goal",
        reason: "Изглежда като устойчив контекст за проекта.",
      },
    ],
  );
});

test("does not propose secrets or sensitive personal data", () => {
  assert.deepEqual(
    extractMemoryCandidates({
      userText: "Предпочитам този API key sk-test-secret. Казвам се Радко.",
      assistantText: "Разбрах.",
    }),
    [
      {
        fact: "Казвам се Радко",
        scope: "personal",
        category: "identity",
        reason:
          "Изглежда като устойчив факт, който може да помогне в бъдещи разговори.",
      },
    ],
  );
});

test("requires a completed assistant reply and ignores transient commands", () => {
  assert.deepEqual(
    extractMemoryCandidates({
      userText: "Изпълни задачата.",
      assistantText: "",
    }),
    [],
  );
  assert.deepEqual(
    extractMemoryCandidates({
      userText: "Дай ми статус и после запомни: временен тест.",
      assistantText: "Готово.",
    }),
    [],
  );
});
