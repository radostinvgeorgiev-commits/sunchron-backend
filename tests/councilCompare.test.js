import assert from "node:assert/strict";
import test from "node:test";
import { formatAiCouncilReply, runAiCouncil } from "../src/services/aiCouncilService.js";

const synthesisJson = JSON.stringify({
  recommendation: "Направи А.",
  rationale: "Двата модела са съгласни за А.",
  risks: [],
  nextSteps: ["Провери А"],
  confidence: "medium",
  agreements: ["А е по-евтино"],
  disagreements: ["Claude предпочита Б, Gemini — А"],
  unique: ["Gemini: има безплатен план"],
});

test("Council reply shows agree / differ / only-one sections", () => {
  const reply = formatAiCouncilReply({
    responses: [
      { provider: "claude", model: "c", text: "Б" },
      { provider: "gemini", model: "g", text: "А" },
    ],
    recommendation: "Направи А.",
    rationale: "x",
    agreements: ["А е по-евтино"],
    disagreements: ["Claude предпочита Б, Gemini — А"],
    unique: ["Gemini: има безплатен план"],
  });
  assert.match(reply, /✅ Съгласни\n- А е по-евтино/u);
  assert.match(reply, /⚖️ Различават се\n- Claude предпочита Б/u);
  assert.match(reply, /💡 Само един модел забеляза\n- Gemini: има безплатен план/u);
  assert.ok(reply.indexOf("✅ Съгласни") < reply.indexOf("Обща препоръка"));
});

test("Gemini synthesizes the council when configured", async () => {
  let claudeArbiterCalls = 0;
  const result = await runAiCouncil({
    message: "А или Б?",
    selectedProviders: ["claude", "gemini"],
    openAiApiKey: "",
    claudeApiKey: "k",
    geminiApiKey: "k",
    advisorRequesters: {
      claude: async () => ({ text: "Б", provider: "claude", model: "c" }),
      gemini: async () => ({ text: "А", provider: "gemini", model: "g" }),
    },
    geminiArbiterRequester: async () => ({
      text: synthesisJson,
      provider: "gemini",
      model: "g",
    }),
    claudeArbiterRequester: async () => {
      claudeArbiterCalls += 1;
      return { text: synthesisJson, provider: "claude", model: "c" };
    },
  });
  assert.equal(claudeArbiterCalls, 0);
  assert.equal(result.arbiter.provider, "gemini");
  assert.deepEqual([...result.agreements], ["А е по-евтино"]);
  assert.equal(result.recommendation, "Направи А.");
});

test("Claude remains an arbiter fallback when Gemini synthesis fails", async () => {
  let claudeArbiterCalls = 0;
  const result = await runAiCouncil({
    message: "А или Б?",
    selectedProviders: ["claude", "gemini"],
    openAiApiKey: "",
    claudeApiKey: "k",
    geminiApiKey: "k",
    advisorRequesters: {
      claude: async () => ({ text: "Б", provider: "claude", model: "c" }),
      gemini: async () => ({ text: "А", provider: "gemini", model: "g" }),
    },
    geminiArbiterRequester: async () => {
      throw new Error("Gemini unavailable");
    },
    claudeArbiterRequester: async () => {
      claudeArbiterCalls += 1;
      return { text: synthesisJson, provider: "claude", model: "c" };
    },
  });
  assert.equal(claudeArbiterCalls, 1);
  assert.equal(result.arbiter.provider, "claude");
});
