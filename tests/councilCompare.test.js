import assert from "node:assert/strict";
import test from "node:test";
import { formatAiCouncilReply, runAiCouncil } from "../src/services/aiCouncilService.js";

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

const VERTEX_ENV = {
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "project-123",
};

test("the Google-only Council returns a Vertex answer without claiming independent review", async () => {
  const result = await runAiCouncil({
    message: "А или Б?",
    env: VERTEX_ENV,
    selectedProviders: ["gemini"],
    advisorRequesters: {
      gemini: async () => ({
        text: "А е по-безопасно.",
        provider: "vertex-gemini",
        model: "gemini-2.5-flash",
      }),
    },
  });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].text, "А е по-безопасно.");
  assert.equal(result.arbiter, null);
  assert.equal(result.confidence, "low");
  assert.match(result.rationale, /няма независима проверка/u);
});

test("external providers are rejected by the Google-only Council", async () => {
  await assert.rejects(
    runAiCouncil({
      message: "А или Б?",
      env: VERTEX_ENV,
      selectedProviders: ["claude", "gemini"],
    }),
    { code: "AI_COUNCIL_INVALID_PROVIDERS" },
  );
});
