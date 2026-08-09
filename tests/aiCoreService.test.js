import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENAI_CHAT_MODEL,
  extractGeminiOutputText,
  extractGrokOutputText,
  extractOpenAIOutputText,
  hasConfiguredAiProvider,
  getAiProviderStatus,
  requestAiResponse,
  requestGeminiResponse,
  requestGrokResponse,
  requestOpenAIResponse,
  requestOpenAIText,
} from "../src/services/aiCoreService.js";

test("AI CORE reports any configured chat provider", () => {
  assert.equal(hasConfiguredAiProvider({ GEMINI_API_KEY: "gemini" }), true);
  assert.equal(hasConfiguredAiProvider({ GROK_API_KEY: "grok" }), true);
  assert.equal(hasConfiguredAiProvider({}), false);
});

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

test("OpenAI Responses supports a dedicated endpoint override", async () => {
  const endpoint = "https://openai-proxy.example/v1/responses";
  await requestOpenAIText({
    apiKey: "test-openai-key",
    responsesUrl: endpoint,
    input: [{ role: "user", content: "Здравей" }],
    fetchImpl: async (url) => {
      assert.equal(url, endpoint);
      return new Response(JSON.stringify({ output_text: "Работи." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
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

test("supports a strict JSON schema for bounded code analysis", async () => {
  const schema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  };
  await requestOpenAIResponse({
    apiKey: "test-openai-key",
    input: [{ role: "user", content: "Провери кода" }],
    outputSchema: schema,
    outputSchemaName: "codex result!",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.text, {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "codex_result_",
          strict: true,
          schema,
        },
      });
      return new Response(JSON.stringify({ output_text: '{"summary":"Да"}' }), {
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

test("Gemini content is extracted and mapped from the shared chat input", async () => {
  assert.equal(
    extractGeminiOutputText({
      candidates: [
        {
          content: {
            parts: [{ text: "Първа част. " }, { text: "Втора част." }],
          },
        },
      ],
    }),
    "Първа част. Втора част.",
  );

  const result = await requestGeminiResponse({
    apiKey: "test-gemini-key",
    apiUrl: "https://gemini.example/v1beta",
    model: "gemini-test",
    input: [
      { role: "system", content: "Говори кратко." },
      { role: "user", content: "Здравей" },
      { role: "assistant", content: "Здравей!" },
    ],
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://gemini.example/v1beta/models/gemini-test:generateContent",
      );
      assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.systemInstruction, {
        parts: [{ text: "Говори кратко." }],
      });
      assert.deepEqual(body.contents, [
        { role: "user", parts: [{ text: "Здравей" }] },
        { role: "model", parts: [{ text: "Здравей!" }] },
      ]);
      return new Response(
        JSON.stringify({
          modelVersion: "gemini-test-001",
          candidates: [
            { content: { parts: [{ text: "Работи." }] } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(result, {
    text: "Работи.",
    provider: "gemini",
    model: "gemini-test-001",
  });
});

test("Grok uses the xAI-compatible chat completion contract", async () => {
  assert.equal(
    extractGrokOutputText({
      choices: [{ message: { content: "Проверено." } }],
    }),
    "Проверено.",
  );

  const result = await requestGrokResponse({
    apiKey: "test-grok-key",
    apiUrl: "https://grok.example/v1/chat/completions",
    model: "grok-test",
    input: [
      { role: "system", content: "Говори кратко." },
      { role: "user", content: "Провери." },
    ],
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://grok.example/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test-grok-key");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "grok-test");
      assert.equal(body.stream, false);
      assert.deepEqual(body.messages, [
        { role: "system", content: "Говори кратко." },
        { role: "user", content: "Провери." },
      ]);
      return new Response(
        JSON.stringify({
          model: "grok-test-001",
          choices: [{ message: { content: "Работи." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(result, {
    text: "Работи.",
    provider: "grok",
    model: "grok-test-001",
  });
});

test("generic AI dispatch and status are explicit without exposing keys", async () => {
  const status = getAiProviderStatus({
    AI_CORE_PROVIDER: "grok",
    OPENAI_API_KEY: "openai-secret",
    GEMINI_API_KEY: "",
    GROK_API_KEY: "grok-secret",
  });
  assert.equal(status.selectedProvider, "grok");
  assert.equal(status.configured, true);
  assert.deepEqual(status.providers, [
    { id: "openai", configured: true },
    { id: "gemini", configured: false },
    { id: "grok", configured: true },
  ]);
  assert.doesNotMatch(JSON.stringify(status), /secret/u);

  const result = await requestAiResponse({
    provider: "grok",
    apiKey: "test-grok-key",
    input: [{ role: "user", content: "Здравей" }],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Работи." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  assert.equal(result.provider, "grok");
  assert.equal(result.text, "Работи.");
});

