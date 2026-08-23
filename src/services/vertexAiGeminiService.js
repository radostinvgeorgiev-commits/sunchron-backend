import {
  extractGeminiOutputText,
  normalizeChatMessages,
} from "./aiMessageContract.js";
import {
  getVertexAiAuthProvider,
  normalizeVertexAiAuthorizationHeader,
  VertexAiAuthError,
} from "./vertexAiAuthService.js";

export const DEFAULT_VERTEX_AI_TIMEOUT_MS = 30_000;
export const MAX_VERTEX_AI_TIMEOUT_MS = 120_000;
export const VERTEX_AI_PROVIDER_ID = "vertex-gemini";

const VERTEX_AI_TYPES = new Map([
  ["unspecified", "TYPE_UNSPECIFIED"],
  ["string", "STRING"],
  ["integer", "INTEGER"],
  ["number", "NUMBER"],
  ["boolean", "BOOLEAN"],
  ["array", "ARRAY"],
  ["object", "OBJECT"],
  ["null", "NULL"],
]);
const SUPPORTED_VERTEX_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "minProperties",
  "maxProperties",
  "items",
  "anyOf",
  "additionalProperties",
]);
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const LOCATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BLOCK_REASONS = new Set([
  "BLOCK_REASON_UNSPECIFIED",
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "MODEL_ARMOR",
  "LANGUAGE",
]);

export class VertexAiGeminiError extends Error {
  constructor(message, code = "VERTEX_AI_ERROR", status = 502) {
    super(message);
    this.name = "VertexAiGeminiError";
    this.code = code;
    this.status = status;
  }
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedTimeout(value, fallback = DEFAULT_VERTEX_AI_TIMEOUT_MS) {
  const parsedFallback = Number.parseInt(fallback, 10);
  const safeFallback =
    Number.isFinite(parsedFallback) && parsedFallback > 0
      ? Math.min(parsedFallback, MAX_VERTEX_AI_TIMEOUT_MS)
      : DEFAULT_VERTEX_AI_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return safeFallback;
  return Math.min(parsed, MAX_VERTEX_AI_TIMEOUT_MS);
}

export function isVertexAiEnabled(env = process.env) {
  return env.VERTEX_AI_ENABLED === "true";
}

export function getVertexAiTimeoutMs(
  env = process.env,
  fallback = DEFAULT_VERTEX_AI_TIMEOUT_MS,
) {
  return boundedTimeout(env.VERTEX_AI_TIMEOUT_MS, fallback);
}

function configuredValue(value, pattern) {
  const clean = cleanValue(value);
  return clean && pattern.test(clean) ? clean : null;
}

export function resolveVertexAiConfig(env = process.env) {
  const projectId = configuredValue(
    env.VERTEX_AI_PROJECT_ID,
    PROJECT_ID_PATTERN,
  );
  const location = configuredValue(env.VERTEX_AI_LOCATION, LOCATION_PATTERN);
  const model = configuredValue(env.VERTEX_AI_MODEL, MODEL_PATTERN);
  const rawValues = [
    ["projectId", env.VERTEX_AI_PROJECT_ID, projectId],
    ["location", env.VERTEX_AI_LOCATION, location],
    ["model", env.VERTEX_AI_MODEL, model],
  ];
  const missing = rawValues
    .filter(([, value]) => !cleanValue(value))
    .map(([name]) => name);
  const invalid = rawValues
    .filter(([name, value, parsed]) => cleanValue(value) && !parsed)
    .map(([name]) => name);
  const enabled = isVertexAiEnabled(env);
  const configured = enabled && missing.length === 0 && invalid.length === 0;

  return Object.freeze({
    enabled,
    configured,
    projectId,
    location,
    model,
    timeoutMs: getVertexAiTimeoutMs(env),
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

export function isVertexAiConfigured(env = process.env) {
  return resolveVertexAiConfig(env).configured;
}

export function getVertexAiProviderStatus(env = process.env) {
  const config = resolveVertexAiConfig(env);
  const availabilityCode = !config.enabled
    ? "VERTEX_AI_DISABLED"
    : config.invalid.length > 0
      ? "VERTEX_AI_CONFIG_INVALID"
      : config.missing.length > 0
        ? "VERTEX_AI_NOT_CONFIGURED"
        : null;
  return {
    provider: VERTEX_AI_PROVIDER_ID,
    enabled: config.enabled,
    selected: false,
    configured: config.configured,
    status: !config.enabled
      ? "disabled"
      : config.configured
        ? "configured"
        : "not-configured",
    auth: {
      mode: "application-default-credentials",
      status: config.enabled && config.configured ? "not-verified" : "not-used",
    },
    configuration: {
      projectConfigured: Boolean(config.projectId),
      locationConfigured: Boolean(config.location),
      modelConfigured: Boolean(config.model),
    },
    availabilityCode,
    missing: config.enabled ? config.missing : [],
    invalid: config.enabled ? config.invalid : [],
  };
}

export function buildVertexAiGenerateContentUrl({
  projectId,
  location,
  model,
}) {
  const config = resolveVertexAiConfig({
    VERTEX_AI_ENABLED: "true",
    VERTEX_AI_PROJECT_ID: projectId,
    VERTEX_AI_LOCATION: location,
    VERTEX_AI_MODEL: model,
  });
  if (!config.configured) {
    throw new VertexAiGeminiError(
      "Vertex AI project, location или model конфигурацията е невалидна.",
      "VERTEX_AI_CONFIG_INVALID",
      503,
    );
  }

  const host =
    config.location === "global"
      ? "aiplatform.googleapis.com"
      : `${config.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(
    config.projectId,
  )}/locations/${encodeURIComponent(
    config.location,
  )}/publishers/google/models/${encodeURIComponent(
    config.model,
  )}:generateContent`;
}

function normalizeVertexSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new VertexAiGeminiError(
      "Vertex AI response schema трябва да е JSON обект.",
      "VERTEX_AI_SCHEMA_INVALID",
      422,
    );
  }
  if (depth > 12) {
    throw new VertexAiGeminiError(
      "Vertex AI response schema е прекалено дълбока.",
      "VERTEX_AI_SCHEMA_INVALID",
      422,
    );
  }

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_VERTEX_SCHEMA_KEYS.has(key)) {
      throw new VertexAiGeminiError(
        "Vertex AI response schema съдържа неподдържано поле.",
        "VERTEX_AI_SCHEMA_UNSUPPORTED",
        422,
      );
    }
    if (key === "additionalProperties") {
      if (value !== false) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema не поддържа additionalProperties.",
          "VERTEX_AI_SCHEMA_UNSUPPORTED",
          422,
        );
      }
      continue;
    }
    if (key === "type") {
      const normalizedType =
        typeof value === "string"
          ? VERTEX_AI_TYPES.get(value.trim().toLowerCase())
          : null;
      if (!normalizedType) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema съдържа неподдържан type.",
          "VERTEX_AI_SCHEMA_UNSUPPORTED",
          422,
        );
      }
      result.type = normalizedType;
      continue;
    }
    if (key === "properties") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema properties трябва да е обект.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result.properties = Object.fromEntries(
        Object.entries(value).map(([property, propertySchema]) => [
          property,
          normalizeVertexSchema(propertySchema, depth + 1),
        ]),
      );
      continue;
    }
    if (key === "items") {
      result.items = normalizeVertexSchema(value, depth + 1);
      continue;
    }
    if (key === "anyOf") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema anyOf трябва да е непразен списък.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result.anyOf = value.map((item) => normalizeVertexSchema(item, depth + 1));
      continue;
    }
    if (key === "required" || key === "propertyOrdering") {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string" || !item.trim())
      ) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema съдържа невалиден списък от полета.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result[key] = [...value];
      continue;
    }
    if (key === "enum") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema enum трябва да е непразен списък от текстове.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result.enum = [...value];
      continue;
    }
    if (key === "nullable") {
      if (typeof value !== "boolean") {
        throw new VertexAiGeminiError(
          "Vertex AI response schema nullable трябва да е boolean.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result.nullable = value;
      continue;
    }
    if (["format", "title", "description"].includes(key)) {
      if (typeof value !== "string" || !value.trim()) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema съдържа невалиден текстов атрибут.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result[key] = value;
      continue;
    }
    if (
      ["maxItems", "minItems", "minProperties", "maxProperties"].includes(key)
    ) {
      if (!Number.isInteger(value) || value < 0) {
        throw new VertexAiGeminiError(
          "Vertex AI response schema съдържа невалидно числово ограничение.",
          "VERTEX_AI_SCHEMA_INVALID",
          422,
        );
      }
      result[key] = value;
      continue;
    }
    result[key] = value;
  }

  if (!result.type) {
    throw new VertexAiGeminiError(
      "Vertex AI response schema трябва да посочва type.",
      "VERTEX_AI_SCHEMA_INVALID",
      422,
    );
  }
  return result;
}

export function normalizeVertexAiResponseSchema(schema) {
  if (schema === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new VertexAiGeminiError(
      "Vertex AI response schema не е сериализируем.",
      "VERTEX_AI_SCHEMA_INVALID",
      422,
    );
  }
  if (!serialized || serialized.length > 32_768) {
    throw new VertexAiGeminiError(
      "Vertex AI response schema е невалидна или прекалено голяма.",
      "VERTEX_AI_SCHEMA_INVALID",
      422,
    );
  }
  return normalizeVertexSchema(JSON.parse(serialized));
}

function createAbortState(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = Boolean(externalSignal?.aborted);
  const abortFromExternal = () => {
    externallyAborted = true;
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get externallyAborted() {
      return externallyAborted;
    },
    cleanup() {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function createAbortError() {
  const error = new Error("Vertex AI request aborted.");
  error.name = "AbortError";
  return error;
}

async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  let abortHandler;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(createAbortError());
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    if (signal.aborted) abortHandler();
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

function hasBlockedResponse(data) {
  const promptBlockReason = data?.promptFeedback?.blockReason;
  if (
    typeof promptBlockReason === "string" &&
    BLOCK_REASONS.has(promptBlockReason)
  ) {
    return true;
  }
  return (Array.isArray(data?.candidates) ? data.candidates : []).some(
    (candidate) =>
      typeof candidate?.finishReason === "string" &&
      BLOCK_REASONS.has(candidate.finishReason),
  );
}

function authorizationHeader(headers) {
  const value =
    headers?.Authorization ||
    headers?.authorization ||
    (typeof headers?.get === "function" ? headers.get("authorization") : null);
  return normalizeVertexAiAuthorizationHeader(value);
}

export async function requestVertexGeminiResponse({
  env = process.env,
  input,
  fetchImpl = fetch,
  authProvider = getVertexAiAuthProvider(),
  signal,
  outputSchema,
} = {}) {
  const config = resolveVertexAiConfig(env);
  if (!config.enabled) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini е изключен.",
      "VERTEX_AI_DISABLED",
      503,
    );
  }
  if (config.invalid.length > 0) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini има невалидна конфигурация.",
      "VERTEX_AI_CONFIG_INVALID",
      503,
    );
  }
  if (!config.configured) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini не е конфигуриран.",
      "VERTEX_AI_NOT_CONFIGURED",
      503,
    );
  }

  const messages = normalizeChatMessages(input);
  const systemMessages = messages
    .filter((item) => item.role === "system")
    .map((item) => item.content);
  const contents = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    }));
  if (!contents.length) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini изисква текстово съобщение.",
      "VERTEX_AI_INPUT_INVALID",
      422,
    );
  }

  const url = buildVertexAiGenerateContentUrl(config);
  const schema = normalizeVertexAiResponseSchema(outputSchema);
  const body = {
    ...(systemMessages.length
      ? {
          systemInstruction: {
            parts: [{ text: systemMessages.join("\n\n") }],
          },
        }
      : {}),
    contents,
    ...(schema
      ? {
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }
      : {}),
  };
  const abortState = createAbortState(signal, config.timeoutMs);

  try {
    if (
      !authProvider ||
      typeof authProvider.getRequestHeaders !== "function"
    ) {
      throw new VertexAiGeminiError(
        "Vertex AI auth provider-ът не е конфигуриран.",
        "VERTEX_AI_AUTH_NOT_CONFIGURED",
        503,
      );
    }
    const authHeaders = await awaitWithAbort(
      authProvider.getRequestHeaders(url, { signal: abortState.signal }),
      abortState.signal,
    );
    const response = await awaitWithAbort(
      fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorizationHeader(authHeaders),
        },
        body: JSON.stringify(body),
        signal: abortState.signal,
      }),
      abortState.signal,
    );
    if (!response.ok) {
      console.error(`[Vertex AI] Upstream request failed: ${response.status}`);
      throw new VertexAiGeminiError(
        `Vertex AI върна грешка ${response.status}.`,
        "VERTEX_AI_UPSTREAM_ERROR",
        response.status,
      );
    }

    let data;
    try {
      data = await awaitWithAbort(response.json(), abortState.signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new VertexAiGeminiError(
        "Vertex AI върна невалиден отговор.",
        "VERTEX_AI_INVALID_RESPONSE",
        502,
      );
    }
    if (hasBlockedResponse(data)) {
      throw new VertexAiGeminiError(
        "Vertex AI блокира отговора според настройките за безопасност.",
        "VERTEX_AI_BLOCKED_RESPONSE",
        502,
      );
    }
    const text = extractGeminiOutputText(data);
    if (!text.trim()) {
      throw new VertexAiGeminiError(
        "Vertex AI не върна текстов отговор.",
        "VERTEX_AI_EMPTY_RESPONSE",
        502,
      );
    }
    return {
      text,
      provider: VERTEX_AI_PROVIDER_ID,
      model:
        typeof data?.modelVersion === "string" && data.modelVersion.trim()
          ? data.modelVersion.trim()
          : config.model,
    };
  } catch (error) {
    if (error instanceof VertexAiGeminiError) throw error;
    if (error instanceof VertexAiAuthError) {
      throw new VertexAiGeminiError(
        "Vertex AI удостоверяването не е достъпно.",
        error.code,
        error.status,
      );
    }
    if (abortState.timedOut) {
      throw new VertexAiGeminiError(
        "Vertex AI не отговори навреме.",
        "VERTEX_AI_TIMEOUT",
        504,
      );
    }
    if (abortState.externallyAborted || error?.name === "AbortError") {
      throw new VertexAiGeminiError(
        "Заявката към Vertex AI беше прекъсната.",
        "VERTEX_AI_ABORTED",
        499,
      );
    }
    throw new VertexAiGeminiError(
      "Vertex AI временно не е достъпен.",
      "VERTEX_AI_UNAVAILABLE",
      502,
    );
  } finally {
    abortState.cleanup();
  }
}
