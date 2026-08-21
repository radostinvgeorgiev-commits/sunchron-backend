import assert from "node:assert/strict";
import test from "node:test";

import {
  AiCouncilError,
  formatAiCouncilReply,
  isMultiEngineCouncilRequest,
  runAiCouncil,
} from "../src/services/aiCouncilService.js";

test("detects explicit requests to consult the three AI engines", () => {
  assert.equal(isMultiEngineCouncilRequest("Питай трите AI модела и сравни."), true);
  assert.equal(isMultiEngineCouncilRequest("Сравни OpenAI, Gemini и Grok."), true);
  assert.equal(isMultiEngineCouncilRequest("Какво е времето днес?"), false);
});

test("council asks OpenAI, Gemini and Grok before a bounded synthesis", async () => {
  const calls = [];
  const advisorRequesters = {
    openai: async (input) => {
      calls.push(["openai", input]);
      return { provider: "openai", model: "gpt-test", text: "OpenAI вариант." };
    },
    gemini: async (input) => {
      calls.push(["gemini", input]);
      return { provider: "gemini", model: "gemini-test", text: "Gemini вариант." };
    },
    grok: async (input) => {
      calls.push(["grok", input]);
      return { provider: "grok", model: "grok-test", text: "Grok вариант." };
    },
  };
  const council = await runAiCouncil({
    message: "Избери безопасния следващ ход.",
    openAiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
    grokApiKey: "grok-key",
    advisorRequesters,
    arbiterRequester: async (input) => {
      calls.push(["arbiter", input]);
      return {
        provider: "openai",
        model: "gpt-test",
        text: JSON.stringify({
          recommendation: "Избери минималната проверима промяна.",
          rationale: "Тя запазва съществуващите граници.",
          risks: ["Нужен е тест."],
          nextSteps: ["Пусни тестовете."],
          confidence: "high",
        }),
      };
    },
  });

  assert.deepEqual(calls.map(([provider]) => provider), [
    "openai",
    "gemini",
    "grok",
    "arbiter",
  ]);
  assert.equal(council.responses.length, 3);
  assert.equal(council.recommendation, "Избери минималната проверима промяна.");
  assert.match(formatAiCouncilReply(council), /трите AI двигателя/u);
});

test("council fails closed when one engine is not configured", async () => {
  await assert.rejects(
    () =>
      runAiCouncil({
        message: "Питай трите двигателя.",
        openAiApiKey: "openai-key",
        geminiApiKey: "",
        grokApiKey: "grok-key",
      }),
    (error) =>
      error instanceof AiCouncilError &&
      error.code === "AI_COUNCIL_NOT_CONFIGURED" &&
      error.status === 503,
  );
});
