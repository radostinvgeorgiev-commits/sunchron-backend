import assert from "node:assert/strict";
import test from "node:test";

import {
  AiCouncilError,
  formatAiCouncilReply,
  isMultiEngineCouncilRequest,
  runAiCouncil,
} from "../src/services/aiCouncilService.js";

test("detects explicit requests to consult the three AI engines", () => {
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

test("council asks OpenAI, Gemini and Grok before a bounded synthesis", async () => {
  const calls = [];
  const advisorRequesters = {
    openai: async (input) => {
      calls.push(["openai", input]);
      return { provider: "openai", model: "gpt-test", text: "OpenAI вариант." };
    },
    gemini: async (input) => {
      calls.push(["gemini", input]);
      return {
        provider: "gemini",
        model: "gemini-test",
        text: "Gemini вариант.",
      };
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
    claudeApiKey: "claude-key",
    selectedProviders: ["openai", "gemini", "grok"],
    advisorRequesters,
    arbiterRequester: async (input) => {
      calls.push(["arbiter", input]);
      assert.match(input.input[0].content, /"recommendation"/u);
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

  assert.deepEqual(
    calls.map(([provider]) => provider),
    ["openai", "gemini", "grok", "arbiter"],
  );
  assert.equal(council.responses.length, 3);
  assert.equal(council.arbiter.provider, "claude");
  assert.equal(council.recommendation, "Избери минималната проверима промяна.");
  assert.match(formatAiCouncilReply(council), /избраните AI двигатели/u);
});

const answer = async () => ({ model: "test", text: "Наличен отговор." });
const options = {
  message: "Кратък тест.",
  openAiApiKey: "a",
  geminiApiKey: "b",
  grokApiKey: "c",
  claudeApiKey: "d",
  selectedProviders: ["openai", "gemini", "grok"],
  advisorRequesters: { openai: answer, gemini: answer, grok: answer },
  arbiterRequester: async () => {
    throw new Error("private provider detail");
  },
};

test("Claude can synthesize available answers when an advisor hangs", async () => {
  const result = await runAiCouncil({
    ...options,
    advisorTimeoutMs: 10,
    advisorRequesters: {
      ...options.advisorRequesters,
      gemini: () => new Promise(() => {}),
    },
    arbiterRequester: async () => ({
      text: JSON.stringify({ recommendation: "Извод", rationale: "Причина", risks: [], nextSteps: [], confidence: "low" }),
    }),
  });
  assert.equal(result.responses.length, 2);
  assert.deepEqual(result.unavailableProviders, ["gemini"]);
  assert.equal(result.arbiter.provider, "claude");
  assert.match(formatAiCouncilReply(result), /Не отговориха: Gemini/);
  assert.doesNotMatch(JSON.stringify(result), /private provider detail/);
});

test("synthesizes one advisor through Claude, rejecting empty and invalid answers", async () => {
  const result = await runAiCouncil({
    ...options,
    openAiApiKey: "",
    advisorRequesters: {
      ...options.advisorRequesters,
      grok: async () => ({ text: "" }),
    },
    arbiterRequester: async () => ({
      text: JSON.stringify({ recommendation: "Извод", rationale: "Причина", risks: [], nextSteps: [], confidence: "low" }),
    }),
  });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].provider, "gemini");
  assert.equal(result.confidence, "low");
});

test("fails closed on malformed or hanging Claude synthesis", async () => {
  for (const arbiterRequester of [
    async () => ({ text: "bad json" }),
    () => new Promise(() => {}),
  ]) {
    await assert.rejects(() => runAiCouncil({
        ...options,
        arbiterRequester,
        arbiterTimeoutMs: 10,
      }),
      (error) => ["AI_COUNCIL_INVALID_SYNTHESIS", "CLAUDE_UNAVAILABLE"].includes(error.code),
    );
  }
});

test("reports failure only when all advisors fail", async () => {
  await assert.rejects(
    () =>
      runAiCouncil({
        ...options,
        openAiApiKey: "",
        geminiApiKey: "",
        grokApiKey: "",
      }),
    (error) =>
      error instanceof AiCouncilError &&
      error.code === "AI_COUNCIL_ADVISORS_FAILED",
  );
});

test("council bounds a verbose advisor", async () => {
  const verbose = "x".repeat(20_000);
  const bounded = await runAiCouncil({
    message: "Кратък тест.",
    openAiApiKey: "openai-key",
    geminiApiKey: "gemini-key",
    grokApiKey: "grok-key",
    claudeApiKey: "claude-key",
    selectedProviders: ["openai", "gemini", "grok"],
    advisorRequesters: {
      openai: async () => ({ model: "openai-test", text: verbose }),
      gemini: async () => ({ model: "gemini-test", text: "Gemini." }),
      grok: async () => ({ model: "grok-test", text: "Grok." }),
    },
    arbiterRequester: async () => ({
      model: "openai-test",
      text: JSON.stringify({
        recommendation: "Тест",
        rationale: "Тест",
        risks: [],
        nextSteps: [],
        confidence: "low",
      }),
    }),
  });
  assert.equal(bounded.responses[0].text.length, 8_000);
});

test("selects Claude only and returns its response without synthesis", async () => {
  const result = await runAiCouncil({
    message: "Тест на Claude.",
    selectedProviders: ["claude"],
    claudeApiKey: "test",
    openAiApiKey: "",
    advisorRequesters: {
      claude: async () => ({
        model: "claude-test",
        text: "Отговор от Claude.",
      }),
    },
  });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].provider, "claude");
  assert.match(result.recommendation, /Отговор от Claude/);
});

test("selected providers exclude others and preserve partial answers", async () => {
  const result = await runAiCouncil({
    message: "Тест на частичен отговор.",
    selectedProviders: ["claude", "gemini"],
    claudeApiKey: "test",
    geminiApiKey: "test",
    openAiApiKey: "",
    advisorRequesters: {
      claude: async () => ({ model: "claude-test", text: "Claude работи." }),
      gemini: async () => {
        throw new Error("unavailable");
      },
    },
  });
  assert.deepEqual(result.unavailableProviders, ["gemini"]);
  assert.equal(result.responses[0].provider, "claude");
});

test("rejects unsupported and duplicate Council provider selection", async () => {
  for (const selectedProviders of [[], ["claude", "claude"], ["unknown"], ["codex"]]) {
    await assert.rejects(
      () => runAiCouncil({ message: "Тест", selectedProviders }),
      (error) =>
        error instanceof AiCouncilError &&
        error.code === "AI_COUNCIL_INVALID_PROVIDERS",
    );
  }
});

test("council requires Claude even when advisors are configured", async () => {
  await assert.rejects(
    () => runAiCouncil({ ...options, claudeApiKey: "" }),
    (error) => error.code === "CLAUDE_NOT_CONFIGURED",
  );
});
