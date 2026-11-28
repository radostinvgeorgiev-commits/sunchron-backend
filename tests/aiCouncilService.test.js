import assert from "node:assert/strict";
import test from "node:test";

import {
  AiCouncilError,
  formatAiCouncilReply,
  isMultiEngineCouncilRequest,
  runAiCouncil,
} from "../src/services/aiCouncilService.js";

const vertexEnv = {
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "novarium-test-12345",
  VERTEX_AI_LOCATION: "us-central1",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
};

test("detects explicit requests for a model comparison", () => {
  assert.equal(
    isMultiEngineCouncilRequest("Питай трите AI модела и сравни."),
    true,
  );
  assert.equal(
    isMultiEngineCouncilRequest("Сравни OpenAI, Gemini и Grok."),
    true,
  );
  assert.equal(isMultiEngineCouncilRequest("Какво е времето днес?"), false);
});

test("Council uses only Vertex Gemini and makes its single-model limit clear", async () => {
  let request;
  const council = await runAiCouncil({
    message: "Избери безопасния следващ ход.",
    context: "Проект: сайт.",
    env: vertexEnv,
    selectedProviders: ["vertex-gemini"],
    advisorRequesters: {
      gemini: async (options) => {
        request = options;
        return {
          provider: "vertex-gemini",
          model: "gemini-test",
          text: "Избери минималната проверима промяна.",
        };
      },
    },
  });

  assert.equal(request.model, "gemini-2.5-flash");
  assert.equal(request.apiKey, undefined);
  assert.match(request.input[0].content, /Избери безопасния следващ ход/u);
  assert.equal(council.responses.length, 1);
  assert.equal(council.responses[0].provider, "gemini");
  assert.equal(
    council.recommendation,
    "Избери минималната проверима промяна.",
  );
  assert.equal(council.confidence, "low");
  assert.equal(council.arbiter, null);
  assert.match(formatAiCouncilReply(council), /Vertex Gemini/u);
  assert.match(formatAiCouncilReply(council), /няма сравнение/u);
});

test("rejects external or multiple model selections", async () => {
  for (const selectedProviders of [
    [],
    ["openai"],
    ["claude", "gemini"],
    ["gemini", "vertex-gemini"],
    ["unknown"],
  ]) {
    await assert.rejects(
      () =>
        runAiCouncil({
          message: "Тест",
          selectedProviders,
          env: vertexEnv,
        }),
      (error) =>
        error instanceof AiCouncilError &&
        error.code === "AI_COUNCIL_INVALID_PROVIDERS",
    );
  }
});

test("does not use a model key as a fallback when Vertex is not configured", async () => {
  await assert.rejects(
    () =>
      runAiCouncil({
        message: "Тест",
        env: {
          GEMINI_API_KEY: "not-used",
          OPENAI_API_KEY: "not-used",
          ANTHROPIC_API_KEY: "not-used",
        },
      }),
    (error) =>
      error instanceof AiCouncilError &&
      error.code === "AI_COUNCIL_ADVISORS_FAILED",
  );
});

test("returns a bounded error when Vertex Gemini fails", async () => {
  await assert.rejects(
    () =>
      runAiCouncil({
        message: "Тест",
        env: vertexEnv,
        advisorRequesters: {
          gemini: async () => {
            throw Object.assign(new Error("private provider detail"), {
              code: "VERTEX_TIMEOUT",
              status: 504,
            });
          },
        },
      }),
    (error) =>
      error instanceof AiCouncilError &&
      error.code === "AI_COUNCIL_ADVISORS_FAILED" &&
      !JSON.stringify(error.failures).includes("private provider detail"),
  );
});

test("bounds a verbose Vertex Gemini answer", async () => {
  const result = await runAiCouncil({
    message: "Кратък тест.",
    env: vertexEnv,
    advisorRequesters: {
      gemini: async () => ({
        model: "gemini-test",
        text: "x".repeat(20_000),
      }),
    },
  });
  assert.equal(result.responses[0].text.length, 8_000);
});
