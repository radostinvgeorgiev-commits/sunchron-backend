import assert from "node:assert/strict";
import test from "node:test";

import {
  createVertexAiAuthProvider,
  GOOGLE_CLOUD_PLATFORM_SCOPE,
  VertexAiAuthError,
} from "../src/services/vertexAiAuthService.js";
import {
  DEFAULT_VERTEX_AI_TIMEOUT_MS,
  buildVertexAiGenerateContentUrl,
  getVertexAiProviderStatus,
  getVertexAiTimeoutMs,
  isVertexAiConfigured,
  normalizeVertexAiResponseSchema,
  requestVertexGeminiResponse,
  resolveVertexAiConfig,
  VertexAiGeminiError,
} from "../src/services/vertexAiGeminiService.js";

const validEnv = Object.freeze({
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "synchron-vertex-test",
  VERTEX_AI_LOCATION: "europe-west1",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
  VERTEX_AI_TIMEOUT_MS: "30000",
});

const authProvider = Object.freeze({
  async getRequestHeaders() {
    return { Authorization: "Bearer test-access-token" };
  },
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestOptions(overrides = {}) {
  return {
    env: validEnv,
    input: [{ role: "user", content: "Провери Vertex." }],
    authProvider,
    ...overrides,
  };
}

test("Vertex config is opt-in, explicit and bounded", () => {
  const disabled = resolveVertexAiConfig({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.configured, false);
  assert.equal(isVertexAiConfigured({}), false);

  const configured = resolveVertexAiConfig(validEnv);
  assert.equal(configured.enabled, true);
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.missing, []);
  assert.deepEqual(configured.invalid, []);
  assert.equal(getVertexAiTimeoutMs({ VERTEX_AI_TIMEOUT_MS: "999999" }), 120_000);
  assert.equal(
    getVertexAiTimeoutMs({ VERTEX_AI_TIMEOUT_MS: "invalid" }),
    DEFAULT_VERTEX_AI_TIMEOUT_MS,
  );
  assert.equal(
    getVertexAiTimeoutMs(
      { VERTEX_AI_TIMEOUT_MS: "invalid" },
      180_000,
    ),
    120_000,
  );
  assert.equal(
    buildVertexAiGenerateContentUrl({
      projectId: "synchron-vertex-test",
      location: "global",
      model: "gemini-2.5-flash",
    }),
    "https://aiplatform.googleapis.com/v1/projects/synchron-vertex-test/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
  );
});

test("Vertex provider status exposes safe independent state", () => {
  const disabled = getVertexAiProviderStatus({});
  assert.deepEqual(disabled, {
    provider: "vertex-gemini",
    enabled: false,
    selected: false,
    configured: false,
    status: "disabled",
    auth: {
      mode: "application-default-credentials",
      status: "not-used",
    },
    configuration: {
      projectConfigured: false,
      locationConfigured: false,
      modelConfigured: false,
    },
    availabilityCode: "VERTEX_AI_DISABLED",
    missing: [],
    invalid: [],
  });

  const configured = getVertexAiProviderStatus(validEnv);
  assert.equal(configured.status, "configured");
  assert.equal(configured.auth.status, "not-verified");
  assert.equal(configured.selected, false);
  assert.deepEqual(configured.configuration, {
    projectConfigured: true,
    locationConfigured: true,
    modelConfigured: true,
  });
  assert.doesNotMatch(JSON.stringify(configured), /synchron-vertex-test/u);

  const partial = getVertexAiProviderStatus({
    VERTEX_AI_ENABLED: "true",
    VERTEX_AI_PROJECT_ID: "synchron-vertex-test",
  });
  assert.equal(partial.status, "not-configured");
  assert.equal(partial.availabilityCode, "VERTEX_AI_NOT_CONFIGURED");
  assert.deepEqual(partial.missing, ["location", "model"]);
});

test("ADC auth provider is lazy and supports Google auth clients", async () => {
  let factoryCalls = 0;
  let requestedUrl;
  const provider = createVertexAiAuthProvider({
    authFactory: () => {
      factoryCalls += 1;
      return {
        getClient: async () => ({
          getRequestHeaders: async (url) => {
            requestedUrl = url;
            return { authorization: "Bearer test-access-token" };
          },
        }),
      };
    },
  });

  assert.equal(factoryCalls, 0);
  const first = await provider.getRequestHeaders(
    "https://europe-west1-aiplatform.googleapis.com/test",
  );
  const second = await provider.getRequestHeaders("https://example.test");
  assert.deepEqual(first, { Authorization: "Bearer test-access-token" });
  assert.deepEqual(second, { Authorization: "Bearer test-access-token" });
  assert.equal(factoryCalls, 1);
  assert.equal(requestedUrl, "https://example.test");
  assert.equal(
    GOOGLE_CLOUD_PLATFORM_SCOPE,
    "https://www.googleapis.com/auth/cloud-platform",
  );
});

test("ADC auth provider validates access tokens and wraps auth failures safely", async () => {
  const tokenProvider = createVertexAiAuthProvider({
    authFactory: () => ({
      getClient: async () => ({
        getAccessToken: async () => ({ token: " test-access-token " }),
      }),
    }),
  });
  assert.deepEqual(await tokenProvider.getRequestHeaders("https://example.test"), {
    Authorization: "Bearer test-access-token",
  });

  const invalidProvider = createVertexAiAuthProvider({
    authFactory: () => ({
      getClient: async () => ({
        getRequestHeaders: async () => ({ authorization: "invalid" }),
      }),
    }),
  });
  await assert.rejects(
    invalidProvider.getRequestHeaders("https://example.test"),
    (error) =>
      error instanceof VertexAiAuthError &&
      error.code === "VERTEX_AI_AUTH_INVALID" &&
      error.status === 503,
  );

  const unavailableProvider = createVertexAiAuthProvider({
    authFactory: () => {
      throw new Error("credential details must not escape");
    },
  });
  await assert.rejects(
    unavailableProvider.getRequestHeaders("https://example.test"),
    (error) =>
      error instanceof VertexAiAuthError &&
      error.code === "VERTEX_AI_AUTH_UNAVAILABLE" &&
      error.status === 503 &&
      !error.message.includes("credential details"),
  );
});

test("Vertex request maps shared chat messages and preserves response metadata", async () => {
  const result = await requestVertexGeminiResponse({
    ...requestOptions({
      input: [
        { role: "system", content: "Говори кратко." },
        { role: "user", content: [{ type: "input_text", text: "Здравей" }] },
        { role: "assistant", content: "Здравей!" },
      ],
      fetchImpl: async (url, options) => {
        assert.equal(
          url,
          "https://europe-west1-aiplatform.googleapis.com/v1/projects/synchron-vertex-test/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent",
        );
        assert.equal(options.headers.Authorization, "Bearer test-access-token");
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(options.body), {
          systemInstruction: { parts: [{ text: "Говори кратко." }] },
          contents: [
            { role: "user", parts: [{ text: "Здравей" }] },
            { role: "model", parts: [{ text: "Здравей!" }] },
          ],
        });
        return jsonResponse({
          modelVersion: "gemini-2.5-flash-001",
          candidates: [{ content: { parts: [{ text: "Работи." }] } }],
        });
      },
    }),
  });

  assert.deepEqual(result, {
    text: "Работи.",
    provider: "vertex-gemini",
    model: "gemini-2.5-flash-001",
  });
});

test("Vertex structured output maps JSON schema to generation config", async () => {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      scores: { type: "array", items: { type: "number" } },
    },
    required: ["summary"],
    additionalProperties: false,
  };

  assert.deepEqual(normalizeVertexAiResponseSchema(schema), {
    type: "OBJECT",
    properties: {
      summary: { type: "STRING" },
      scores: { type: "ARRAY", items: { type: "NUMBER" } },
    },
    required: ["summary"],
  });

  await requestVertexGeminiResponse({
    ...requestOptions({
      outputSchema: schema,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.generationConfig, {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              summary: { type: "STRING" },
              scores: { type: "ARRAY", items: { type: "NUMBER" } },
            },
            required: ["summary"],
          },
        });
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"summary":"Да"}' }] } }],
        });
      },
    }),
  });
});

test("Vertex rejects disabled, incomplete and invalid configuration before network access", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({});
  };

  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({ env: { VERTEX_AI_ENABLED: "false" }, fetchImpl }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_DISABLED" &&
      error.status === 503,
  );
  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        env: { VERTEX_AI_ENABLED: "true", VERTEX_AI_PROJECT_ID: "project" },
        fetchImpl,
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_NOT_CONFIGURED" &&
      error.status === 503,
  );
  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        env: { ...validEnv, VERTEX_AI_PROJECT_ID: "invalid project" },
        fetchImpl,
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_CONFIG_INVALID" &&
      error.status === 503,
  );
  assert.equal(fetchCalls, 0);
});

test("Vertex rejects unsupported response schemas explicitly", () => {
  assert.throws(
    () =>
      normalizeVertexAiResponseSchema({
        type: "object",
        additionalProperties: true,
      }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_SCHEMA_UNSUPPORTED",
  );
  assert.throws(
    () => normalizeVertexAiResponseSchema({ type: "date" }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_SCHEMA_UNSUPPORTED",
  );
  assert.throws(
    () =>
      normalizeVertexAiResponseSchema({
        type: "object",
        oneOf: [{ type: "string" }],
      }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_SCHEMA_UNSUPPORTED",
  );
  assert.deepEqual(
    normalizeVertexAiResponseSchema({ type: "object", properties: {} }),
    { type: "OBJECT", properties: {} },
  );
});

test("Vertex maps auth and upstream failures to safe provider errors", async () => {
  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        authProvider: {
          getRequestHeaders: async () => {
            throw new VertexAiAuthError(
              "sensitive auth detail",
              "VERTEX_AI_AUTH_UNAVAILABLE",
              503,
            );
          },
        },
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_AUTH_UNAVAILABLE" &&
      error.status === 503 &&
      !error.message.includes("sensitive"),
  );

  const originalConsoleError = console.error;
  const logLines = [];
  console.error = (...args) => logLines.push(args.join(" "));
  try {
    for (const status of [401, 403, 429, 500]) {
      await assert.rejects(
        requestVertexGeminiResponse({
          ...requestOptions({
            fetchImpl: async () => jsonResponse({ error: "upstream detail" }, status),
          }),
        }),
        (error) =>
          error instanceof VertexAiGeminiError &&
          error.code === "VERTEX_AI_UPSTREAM_ERROR" &&
          error.status === status &&
          !error.message.includes("upstream detail"),
      );
    }
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logLines, [
    "[Vertex AI] Upstream request failed: 401",
    "[Vertex AI] Upstream request failed: 403",
    "[Vertex AI] Upstream request failed: 429",
    "[Vertex AI] Upstream request failed: 500",
  ]);
});

test("Vertex distinguishes timeout and caller abort", async () => {
  const pendingFetch = async (_url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });

  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        env: { ...validEnv, VERTEX_AI_TIMEOUT_MS: "5" },
        fetchImpl: pendingFetch,
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_TIMEOUT" &&
      error.status === 504,
  );

  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        env: { ...validEnv, VERTEX_AI_TIMEOUT_MS: "5" },
        fetchImpl: async () => ({
          ok: true,
          json: () => new Promise(() => {}),
        }),
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_TIMEOUT" &&
      error.status === 504,
  );

  const controller = new AbortController();
  const request = requestVertexGeminiResponse({
    ...requestOptions({
      fetchImpl: pendingFetch,
      signal: controller.signal,
    }),
  });
  controller.abort();
  await assert.rejects(
    request,
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_ABORTED" &&
      error.status === 499,
  );
});

test("Vertex reports blocked, empty and invalid responses safely", async () => {
  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        fetchImpl: async () =>
          jsonResponse({
            promptFeedback: { blockReason: "SAFETY" },
            candidates: [
              { content: { parts: [{ text: "частичен отговор" }] } },
            ],
          }),
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_BLOCKED_RESPONSE",
  );

  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        fetchImpl: async () =>
          jsonResponse({
            candidates: [{ finishReason: "STOP", content: { parts: [] } }],
          }),
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_EMPTY_RESPONSE",
  );

  await assert.rejects(
    requestVertexGeminiResponse({
      ...requestOptions({
        fetchImpl: async () =>
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    }),
    (error) =>
      error instanceof VertexAiGeminiError &&
      error.code === "VERTEX_AI_INVALID_RESPONSE",
  );
});
