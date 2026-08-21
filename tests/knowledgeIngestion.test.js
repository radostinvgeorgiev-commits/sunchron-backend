import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgePreview,
  classifyKnowledgeText,
  normalizeArchiveDocuments,
  normalizeKnowledgeCandidates,
} from "../src/services/knowledgeIngestionService.js";

test("normalizes a ChatGPT-style mapping export and ignores assistant output", () => {
  const documents = normalizeArchiveDocuments({
    conversations: [
      {
        id: "chat-1",
        title: "Основата",
        mapping: {
          a: { message: { author: { role: "user" }, content: { parts: ["Това е целта на проекта."] }, create_time: 1 } },
          b: { message: { author: { role: "assistant" }, content: { parts: ["Измислен отговор."] }, create_time: 2 } },
        },
      },
    ],
  });

  assert.equal(documents.length, 1);
  assert.equal(documents[0].messages.length, 2);
  assert.equal(documents[0].messages[0].role, "user");
  assert.match(documents[0].messages[1].text, /Измислен отговор/u);

  const preview = buildKnowledgePreview({ conversations: [{ ...documents[0], mapping: undefined, messages: documents[0].messages }] });
  assert.equal(preview.candidateCount, 1);
  assert.doesNotMatch(preview.candidates[0].text, /Измислен/u);
});

test("classifies archive candidates conservatively", () => {
  assert.equal(classifyKnowledgeText("Решихме да използваме Firestore."), "decision");
  assert.equal(classifyKnowledgeText("Идея: да има мобилно приложение."), "idea");
  assert.equal(classifyKnowledgeText("Старият сайт не го използваме."), "obsolete");
  assert.equal(classifyKnowledgeText("Имам режим за хранене."), "fact");
});

test("preview deduplicates candidates and preserves source metadata", () => {
  const preview = buildKnowledgePreview([
    { id: "a", title: "Първи", text: "Искам AI CORE да следи задачите ми." },
    { id: "b", title: "Втори", text: "Искам AI CORE да следи задачите ми." },
  ]);

  assert.equal(preview.documentCount, 2);
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.candidates[0].sourceTitle, "Първи");
  assert.equal(preview.candidates[0].scope, "personal");
});

test("import selection is bounded and normalized", () => {
  const candidates = normalizeKnowledgeCandidates([
    { id: "a", text: "Текущата цел на проекта е работещ прототип.", scope: "project" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, "fact");
  assert.equal(candidates[0].status, "proposed");
});

test("invalid archive input is a safe client error", () => {
  assert.throws(
    () => normalizeKnowledgeCandidates([]),
    (error) => error.code === "INVALID_KNOWLEDGE" && error.status === 400,
  );
});
