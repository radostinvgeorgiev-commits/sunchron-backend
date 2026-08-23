import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_PROVIDERS,
  getAiProviderTimeoutMs,
  getAiProviderStatus,
  getConfiguredAiProvider,
  isAiProviderConfigured,
  requestAiResponse,
} from "../src/services/aiCoreService.js";
import {
  buildVertexAiGenerateContentEndpoint,
  extractVertexAiOutputText,
  isVertexAiConfigured,
  normalizeVertexAiMessages,
  requestVertexAiGeminiResponse,
  resolveVertexAiConfig,
  resolveVertexAiEnabled,
  resolveVertexAiTimeoutMs,
  validateVertexResponseSchema,
} from "../src/services/vertexAiGeminiService.js";
import {
  GOOGLE_CLOUD_PLATFORM_SCOPE,
  createGoogleAuth,
  createGoogleAuthClient,
} from "../src/services/googleAdcAuth.js";

const VERTEX_ENV = Object.freeze({
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "project-123",
  VERTEX_AI_LOCATION: "europe-west4",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
  VERTEX_AI_TIMEOUT_MS: "30000",
});

function vertexResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeAuthClient(
  getRequestHeaders = async () => ({
    Authorization: "Bearer fake-adc-token",
  }),
) {
  return { getRequestHeaders };
}

test("Vertex configuration is disabled by default and timeout is bounded", () => {
  assert.equal(resolveVertexAiEnabled({}), false);
  assert.equal(resolveVertexAiEnabled({ VERTEX_AI_ENABLED: "false" }), false);
  assert.equal(resolveVertexAiEnabled({ VERTEX_AI_ENABLED: "TRUE" }), true);
  assert.equal(resolveVertexAiTimeoutMs({ VERTEX_AI_TIMEOUT_MS: "10" }), 1_000);
  assert.equal(
    resolveVertexAiTimeoutMs({ VERTEX_AI_TIMEOUT_MS: "999999" }),
    120_000,
  );
  const inheritedEnvironment = Object.create({ marker: true });
  inheritedEnvironment.VERTEX_AI_TIMEOUT_MS = "4500";
  assert.equal(resolveVertexAiTimeoutMs(inheritedEnvironment), 4_500);
  assert.equal(
    resolveVertexAiTimeoutMs({ VERTEX_AI_TIMEOUT_MS: "invalid" }),
    30_000,
  );

  const config = resolveVertexAiConfig(VERTEX_ENV);
  assert.equal(config.enabled, true);
  assert.equal(config.configured, true);
  assert.equal(config.projectId, "project-123");
  assert.equal(config.location, "europe-west4");
  assert.equal(config.model, "gemini-2.5-flash");
  assert.equal(isVertexAiConfigured(VERTEX_ENV), true);
  assert.equal(
    isVertexAiConfigured({
      ...VERTEX_ENV,
      VERTEX_AI_ENABLED: "false",
    }),
    false,
  );
  assert.equal(
    isVertexAiConfigured({
      ...VERTEX_ENV,
      VERTEX_AI_PROJECT_ID: "not valid",
    }),
    false,
  );
});

test("ADC uses only the cloud-platform scope and injectable factories", async () => {
  let constructorOptions;
  class FakeGoogleAuth {
    constructor(options) {
      constructorOptions = options;
    }

    async getClient() {
      return fakeAuthClient();
    }
  }

  createGoogleAuth({ GoogleAuthClass: FakeGoogleAuth });
  assert.deepEqual(constructorOptions, {
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
  });

  const expectedClient = fakeAuthClient();
  let factoryAuth;
  const client = await createGoogleAuthClient({
    googleAuthFactory: async () => ({ marker: "auth" }),
    clientFactory: async (auth) => {
      factoryAuth = auth;
      return expectedClient;
    },
  });
  assert.equal(factoryAuth.marker, "auth");
  assert.equal(client, expectedClient);
});

test("ADC failures are explicit and do not expose the original error", async () => {
  await assert.rejects(
    createGoogleAuthClient({
      googleAuthFactory: async () => {
        throw new Error("private-token-value");
      },
      clientFactory: async () => fakeAuthClient(),
    }),
    (error) => {
      assert.equal(error.code, "GOOGLE_ADC_AUTH_FAILED");
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /private-token-value/u);
      return true;
    },
  );
});

test("Vertex endpoint is fixed, encoded, and rejects unsafe identifiers", () => {
  assert.equal(
    buildVertexAiGenerateContentEndpoint({
      projectId: "project-123",
      location: "europe-west4",
      model: "gemini-2.5-flash",
    }),
    "https://europe-west4-aiplatform.googleapis.com/v1/projects/project-123/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent",
  );
  assert.throws(
    () =>
      buildVertexAiGenerateContentEndpoint({
        projectId: "project-123/secret",
        location: "europe-west4",
        model: "gemini-2.5-flash",
      }),
    { code: "VERTEX_GEMINI_CONFIG_INVALID" },
  );
});

test("Vertex maps shared chat input, auth headers, structured schema, and metadata", async () => {
  const input = [
    { role: "system", content: "Говори кратко." },
    { role: "user", content: [{ text: "Здравей" }] },
    { role: "assistant", content: [{ output_text: "Здравей!" }] },
  ];
  assert.deepEqual(normalizeVertexAiMessages(input), [
    { role: "system", content: "Говори кратко." },
    { role: "user", content: "Здравей" },
    { role: "assistant", content: "Здравей!" },
  ]);

  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };
  const seen = {};
  const result = await requestVertexAiGeminiResponse({
    env: VERTEX_ENV,
    input,
    outputSchema: schema,
    authClient: fakeAuthClient(async (endpoint) => {
      seen.authEndpoint = endpoint;
      return { Authorization: "Bearer fake-adc-token" };
    }),
    fetchImpl: async (endpoint, options) => {
      seen.endpoint = endpoint;
      seen.options = options;
      return vertexResponse({
        modelVersion: "gemini-2.5-flash-001",
        candidates: [{ content: { parts: [{ text: "Работи." }] } }],
      });
    },
  });

  assert.equal(
    seen.endpoint,
    "https://europe-west4-aiplatform.googleapis.com/v1/projects/project-123/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(seen.authEndpoint, seen.endpoint);
  assert.equal(seen.options.headers.Authorization, "Bearer fake-adc-token");
  const body = JSON.parse(seen.options.body);
  assert.deepEqual(body.systemInstruction, {
    parts: [{ text: "Говори кратко." }],
  });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "Здравей" }] },
    { role: "model", parts: [{ text: "Здравей!" }] },
  ]);
  assert.deepEqual(body.generationConfig, {
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: { answer: { type: "STRING" } },
      required: ["answer"],
    },
  });
  assert.deepEqual(result, {
    text: "Работи.",
    provider: "vertex-gemini",
    model: "gemini-2.5-flash-001",
  });
  assert.equal(
    extractVertexAiOutputText({
      candidates: [{ content: { parts: [{ text: "A" }, { text: "B" }] } }],
    }),
    "AB",
  );
});

test("unsupported Vertex schema and disabled provider fail closed before auth", async () => {
  let authCalls = 0;
  const authClient = fakeAuthClient(async () => {
    authCalls += 1;
    return { Authorization: "Bearer should-not-be-used" };
  });
  await assert.rejects(
    requestVertexAiGeminiResponse({
      env: VERTEX_ENV,
      input: [{ role: "user", content: "Здравей" }],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        additionalProperties: false,
      },
      authClient,
      fetchImpl: async () => vertexResponse({}),
    }),
    { code: "VERTEX_GEMINI_SCHEMA_UNSUPPORTED" },
  );
  await assert.rejects(
    requestVertexAiGeminiResponse({
      env: { ...VERTEX_ENV, VERTEX_AI_ENABLED: "false" },
      input: [{ role: "user", content: "Здравей" }],
      authClient,
      fetchImpl: async () => vertexResponse({}),
    }),
    { code: "VERTEX_GEMINI_DISABLED" },
  );
  assert.equal(authCalls, 0);
  assert.throws(
    () =>
      validateVertexResponseSchema({
        type: "object",
        properties: { answer: { type: "oneOf" } },
      }),
    { code: "VERTEX_GEMINI_SCHEMA_UNSUPPORTED" },
  );
});

test("Vertex ADC errors have a safe machine code", async () => {
  await assert.rejects(
    requestVertexAiGeminiResponse({
      env: VERTEX_ENV,
      input: [{ role: "user", content: "Здравей" }],
      googleAuthFactory: async () => {
        throw new Error("credential-secret");
      },
      fetchImpl: async () => vertexResponse({}),
    }),
    (error) => {
      assert.equal(error.code, "VERTEX_GEMINI_ADC_AUTH_FAILED");
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /credential-secret/u);
      return true;
    },
  );
});

test("Vertex distinguishes unauthorized, forbidden, rate limit, and upstream failures", async () => {
  for (const [status, code] of [
    [401, "VERTEX_GEMINI_UNAUTHORIZED"],
    [403, "VERTEX_GEMINI_FORBIDDEN"],
    [429, "VERTEX_GEMINI_RATE_LIMITED"],
    [503, "VERTEX_GEMINI_UPSTREAM_5XX"],
  ]) {
    await assert.rejects(
      requestVertexAiGeminiResponse({
        env: VERTEX_ENV,
        input: [{ role: "user", content: "Здравей" }],
        authClient: fakeAuthClient(),
        fetchImpl: async () => new Response("", { status }),
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /fake-adc-token|credential/u);
        return true;
      },
    );
  }
});

test("Vertex distinguishes empty and blocked responses", async () => {
  for (const body of [
    { candidates: [] },
    { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
  ]) {
    await assert.rejects(
      requestVertexAiGeminiResponse({
        env: VERTEX_ENV,
        input: [{ role: "user", content: "Здравей" }],
        authClient: fakeAuthClient(),
        fetchImpl: async () => vertexResponse(body),
      }),
      { code: "VERTEX_GEMINI_EMPTY_RESPONSE" },
    );
  }
  await assert.rejects(
    requestVertexAiGeminiResponse({
      env: VERTEX_ENV,
      input: [{ role: "user", content: "Здравей" }],
      authClient: fakeAuthClient(),
      fetchImpl: async () =>
        vertexResponse({
          promptFeedback: { blockReason: "SAFETY" },
          candidates: [],
        }),
    }),
    { code: "VERTEX_GEMINI_BLOCKED_RESPONSE" },
  );
});

test("Vertex timeout and external abort stay distinct", async () => {
  let timeoutAborted = false;
  await assert.rejects(
    requestVertexAiGeminiResponse({
      env: VERTEX_ENV,
      timeoutMs: 1_000,
      input: [{ role: "user", content: "Здравей" }],
      authClient: fakeAuthClient(),
      fetchImpl: async (_endpoint, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            timeoutAborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }),
    { code: "VERTEX_GEMINI_TIMEOUT" },
  );
  assert.equal(timeoutAborted, true);

  const controller = new AbortController();
  const pending = requestVertexAiGeminiResponse({
    env: VERTEX_ENV,
    input: [{ role: "user", content: "Здравей" }],
    signal: controller.signal,
    authClient: fakeAuthClient(),
    fetchImpl: async (_endpoint, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "VERTEX_GEMINI_CLIENT_ABORT" });
});

test("AI Core keeps OpenAI default and only explicitly selects configured Vertex", () => {
  assert.equal(getConfiguredAiProvider({}), "openai");
  assert.equal(
    getConfiguredAiProvider({
      AI_CORE_PROVIDER: "vertex-gemini",
    }),
    "vertex-gemini",
  );
  assert.equal(isAiProviderConfigured("vertex-gemini", VERTEX_ENV), true);
  assert.equal(
    isAiProviderConfigured("vertex-gemini", {
      ...VERTEX_ENV,
      VERTEX_AI_ENABLED: "false",
    }),
    false,
  );
  assert.equal(
    getAiProviderTimeoutMs(
      "vertex-gemini",
      { VERTEX_AI_TIMEOUT_MS: "10" },
      120_000,
    ),
    1_000,
  );
  assert.equal(getAiProviderTimeoutMs("vertex-gemini", {}), 30_000);
  assert.deepEqual(
    getAiProviderStatus({
      AI_CORE_PROVIDER: "vertex-gemini",
      ...VERTEX_ENV,
    }),
    {
      selectedProvider: "vertex-gemini",
      primaryProvider: "vertex-gemini",
      configured: true,
      providers: [
        { id: "openai", configured: false },
        { id: "gemini", configured: false },
        { id: "grok", configured: false },
        { id: "vertex-gemini", configured: true },
      ],
    },
  );
  assert.deepEqual(
    [...AI_PROVIDERS],
    ["openai", "gemini", "grok", "vertex-gemini"],
  );
});

test("AI Core dispatches an explicit Vertex request without fallback", async () => {
  const result = await requestAiResponse({
    env: { ...VERTEX_ENV, AI_CORE_PROVIDER: "vertex-gemini" },
    input: [{ role: "user", content: "Здравей" }],
    authClient: fakeAuthClient(),
    fetchImpl: async () =>
      vertexResponse({
        candidates: [{ content: { parts: [{ text: "Vertex отговор." }] } }],
      }),
  });
  assert.deepEqual(result, {
    text: "Vertex отговор.",
    provider: "vertex-gemini",
    model: "gemini-2.5-flash",
  });
});
