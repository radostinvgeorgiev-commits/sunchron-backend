import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENAI_CHAT_MODEL,
  extractOpenAIOutputText,
  requestOpenAIResponse,
  requestOpenAIText,
} from "../src/services/aiCoreService.js";

test("OpenAI Responses output text is extracted from typed output items", () => {
  assert.equal(
    extractOpenAIOutputText({
      output: [
        { type: "reasoning", content: [] },
        {
          type: "message",
          content: [
            { type: "output_text", text: "Първа част. " },
            { type: "output_text", text: "Втора част." },
          ],
        },
      ],
    }),
    "Първа част. Втора част.",
  );
});

test("OpenAI Responses request preserves local state and uses the balanced chat model", async () => {
  const result = await requestOpenAIText({
    apiKey: "test-openai-key",
    input: [{ role: "user", content: "Здравей" }],
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(options.headers.Authorization, "Bearer test-openai-key");
      const body = JSON.parse(options.body);
      assert.equal(body.model, DEFAULT_OPENAI_CHAT_MODEL);
      assert.equal(body.store, false);
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.deepEqual(body.text, { verbosity: "low" });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Работи." }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result, "Работи.");
});

test("allows the final conversation to request stronger reasoning and detail", async () => {
  await requestOpenAIText({
    apiKey: "test-openai-key",
    input: [{ role: "user", content: "Провери внимателно" }],
    reasoningEffort: "low",
    verbosity: "medium",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.reasoning, { effort: "low" });
      assert.deepEqual(body.text, { verbosity: "medium" });
      return new Response(JSON.stringify({ output_text: "Проверено." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
});

test("returns the provider and model reported by OpenAI", async () => {
  const result = await requestOpenAIResponse({
    apiKey: "test-openai-key",
    input: [{ role: "user", content: "Кой модел работи?" }],
    model: "requested-model",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "actual-response-model",
          output_text: "Проверено.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.deepEqual(result, {
    text: "Проверено.",
    provider: "openai",
    model: "actual-response-model",
  });
});
