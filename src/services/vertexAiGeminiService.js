import {
  createGoogleAuthClient,
  GOOGLE_CLOUD_PLATFORM_SCOPE,
  GoogleAdcAuthError,
} from "./googleAdcAuth.js";

const DEFAULT_VERTEX_AI_LOCATION = "us-central1";
const DEFAULT_VERTEX_AI_MODEL = "gemini-2.5-flash";
const DEFAULT_VERTEX_AI_TIMEOUT_MS = 30_000;
const MIN_VERTEX_AI_TIMEOUT_MS = 1_000;
const MAX_VERTEX_AI_TIMEOUT_MS = 120_000;
const VERTEX_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const VERTEX_LOCATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERTEX_MODEL_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u;
const BLOCKED_FINISH_REASONS = new Set([
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SAFETY",
  "SPII",
]);
const SCHEMA_TYPES = new Set([
  "ARRAY",
  "BOOLEAN",
  "INTEGER",
  "NUMBER",
  "OBJECT",
  "STRING",
]);
const SCHEMA_KEYS = new Set([
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 100;

export const VERTEX_AI_SCOPE = GOOGLE_CLOUD_PLATFORM_SCOPE;
export const VERTEX_AI_DEFAULT_LOCATION = DEFAULT_VERTEX_AI_LOCATION;
export const VERTEX_AI_DEFAULT_MODEL = DEFAULT_VERTEX_AI_MODEL;
export const VERTEX_AI_DEFAULT_TIMEOUT_MS = DEFAULT_VERTEX_AI_TIMEOUT_MS;
export const VERTEX_AI_MIN_TIMEOUT_MS = MIN_VERTEX_AI_TIMEOUT_MS;
export const VERTEX_AI_MAX_TIMEOUT_MS = MAX_VERTEX_AI_TIMEOUT_MS;

export class VertexAiGeminiError extends Error {
  constructor(message, code = "VERTEX_GEMINI_ERROR", status = 502) {
    super(message);
    this.name = "VertexAiGeminiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedInteger(value, fallback) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(
    MAX_VERTEX_AI_TIMEOUT_MS,
    Math.max(MIN_VERTEX_AI_TIMEOUT_MS, parsed),
  );
}

export function resolveVertexAiEnabled(env = process.env) {
  const value = env?.VERTEX_AI_ENABLED;
  return (
    value === true ||
    (typeof value === "string" && value.trim().toLowerCase() === "true")
  );
}

export function resolveVertexAiProjectId(env = process.env) {
  return cleanValue(env?.VERTEX_AI_PROJECT_ID);
}

export function resolveVertexAiLocation(env = process.env) {
  return cleanValue(env?.VERTEX_AI_LOCATION) || DEFAULT_VERTEX_AI_LOCATION;
}

export function resolveVertexAiModel(env = process.env) {
  return cleanValue(env?.VERTEX_AI_MODEL) || DEFAULT_VERTEX_AI_MODEL;
}

export function resolveVertexAiTimeoutMs(
  envOrValue = process.env,
  fallback = DEFAULT_VERTEX_AI_TIMEOUT_MS,
) {
  const value =
    envOrValue &&
    typeof envOrValue === "object" &&
    !Array.isArray(envOrValue) &&
    Object.hasOwn(envOrValue, "VERTEX_AI_TIMEOUT_MS")
      ? envOrValue.VERTEX_AI_TIMEOUT_MS
      : envOrValue;
  return boundedInteger(
    value,
    boundedInteger(fallback, DEFAULT_VERTEX_AI_TIMEOUT_MS),
  );
}

function isValidProjectId(value) {
  return (
    typeof value === "string" &&
    value.length >= 6 &&
    value.length <= 30 &&
    VERTEX_PROJECT_ID_PATTERN.test(value)
  );
}

function isValidLocation(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 63 &&
    VERTEX_LOCATION_PATTERN.test(value)
  );
}

function isValidModel(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    VERTEX_MODEL_PATTERN.test(value)
  );
}

export function resolveVertexAiConfig(env = process.env) {
  const enabled = resolveVertexAiEnabled(env);
  const projectId = resolveVertexAiProjectId(env);
  const location = resolveVertexAiLocation(env);
  const model = resolveVertexAiModel(env);
  const invalidFields = [
    ...(isValidProjectId(projectId) ? [] : ["VERTEX_AI_PROJECT_ID"]),
    ...(isValidLocation(location) ? [] : ["VERTEX_AI_LOCATION"]),
    ...(isValidModel(model) ? [] : ["VERTEX_AI_MODEL"]),
  ];

  return Object.freeze({
    enabled,
    projectId,
    location,
    model,
    timeoutMs: resolveVertexAiTimeoutMs(env),
    configured: enabled && invalidFields.length === 0,
    invalidFields: Object.freeze(invalidFields),
  });
}

export const getVertexAiConfig = resolveVertexAiConfig;

export function isVertexAiConfigured(env = process.env) {
  return resolveVertexAiConfig(env).configured;
}

function configError(message, code = "VERTEX_GEMINI_CONFIG_INVALID") {
  return new VertexAiGeminiError(message, code, 503);
}

function requireIdentifier(value, validator, message) {
  if (!validator(value)) throw configError(message);
  return value;
}

export function buildVertexAiGenerateContentEndpoint({
  projectId,
  location,
  model,
} = {}) {
  const safeProjectId = requireIdentifier(
    cleanValue(projectId),
    isValidProjectId,
    "Vertex AI Gemini има невалиден project ID.",
  );
  const safeLocation = requireIdentifier(
    cleanValue(location),
    isValidLocation,
    "Vertex AI Gemini има невалиден location.",
  );
  const safeModel = requireIdentifier(
    cleanValue(model),
    isValidModel,
    "Vertex AI Gemini има невалиден model.",
  );

  return [
    `https://${safeLocation}-aiplatform.googleapis.com/v1`,
    `projects/${encodeURIComponent(safeProjectId)}`,
    `locations/${encodeURIComponent(safeLocation)}`,
    "publishers/google",
    `models/${encodeURIComponent(safeModel)}:generateContent`,
  ].join("/");
}

export const buildVertexAiEndpoint = buildVertexAiGenerateContentEndpoint;

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return (
        [part.text, part.input_text, part.output_text].find(
          (value) => typeof value === "string",
        ) || ""
      );
    })
    .join("");
}

export function normalizeVertexAiMessages(input) {
  return (Array.isArray(input) ? input : [])
    .map((item) => ({
      role:
        item?.role === "assistant" || item?.role === "model"
          ? "assistant"
          : item?.role === "system"
            ? "system"
            : "user",
      content: extractTextContent(item?.content),
    }))
    .filter((item) => item.content.trim());
}

export function extractVertexAiOutputText(data) {
  return (Array.isArray(data?.candidates) ? data.candidates : [])
    .flatMap((candidate) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
    )
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function schemaError(path, reason) {
  return configError(
    `Vertex AI Gemini не поддържа responseSchema (${path}: ${reason}).`,
    "VERTEX_GEMINI_SCHEMA_UNSUPPORTED",
  );
}

function validateSchemaNode(schema, path, seen, depth) {
  if (!isRecord(schema)) throw schemaError(path, "очаква се обект");
  if (seen.has(schema)) throw schemaError(path, "циклична структура");
  if (depth > MAX_SCHEMA_DEPTH) throw schemaError(path, "прекалена дълбочина");
  seen.add(schema);

  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw schemaError(`${path}.${key}`, "неподдържано поле");
    }
  }

  const type = typeof schema.type === "string" ? schema.type.toUpperCase() : "";
  if (!SCHEMA_TYPES.has(type)) {
    throw schemaError(`${path}.type`, "липсващ или невалиден тип");
  }
  if (schema.format !== undefined && typeof schema.format !== "string") {
    throw schemaError(`${path}.format`, "форматът трябва да е текст");
  }
  for (const key of ["title", "description", "pattern"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      throw schemaError(`${path}.${key}`, "стойността трябва да е текст");
    }
  }
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    throw schemaError(`${path}.nullable`, "стойността трябва да е boolean");
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.some(
        (value) =>
          value === null ||
          (typeof value === "object" && value !== null) ||
          typeof value === "function",
      )
    ) {
      throw schemaError(`${path}.enum`, "enum е невалиден");
    }
  }
  for (const key of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minProperties",
    "maxProperties",
  ]) {
    if (
      schema[key] !== undefined &&
      (!Number.isSafeInteger(schema[key]) || schema[key] < 0)
    ) {
      throw schemaError(`${path}.${key}`, "ограничението е невалидно");
    }
  }
  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
      throw schemaError(`${path}.${key}`, "ограничението е невалидно");
    }
  }
  if (schema.properties !== undefined) {
    if (
      type !== "OBJECT" ||
      !isRecord(schema.properties) ||
      Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES
    ) {
      throw schemaError(`${path}.properties`, "properties е невалиден");
    }
    for (const [property, propertySchema] of Object.entries(
      schema.properties,
    )) {
      validateSchemaNode(
        propertySchema,
        `${path}.properties.${property}`,
        seen,
        depth + 1,
      );
    }
  } else if (type === "OBJECT" && schema.required?.length) {
    throw schemaError(`${path}.required`, "липсват properties");
  }
  if (schema.items !== undefined) {
    if (type !== "ARRAY") {
      throw schemaError(`${path}.items`, "items е позволен само за array");
    }
    validateSchemaNode(schema.items, `${path}.items`, seen, depth + 1);
  } else if (type === "ARRAY") {
    throw schemaError(`${path}.items`, "array изисква items");
  }
  if (schema.required !== undefined) {
    if (
      type !== "OBJECT" ||
      !Array.isArray(schema.required) ||
      schema.required.some(
        (value) =>
          typeof value !== "string" ||
          !Object.hasOwn(schema.properties || {}, value),
      )
    ) {
      throw schemaError(`${path}.required`, "required е невалиден");
    }
  }
  if (schema.propertyOrdering !== undefined) {
    if (
      type !== "OBJECT" ||
      !Array.isArray(schema.propertyOrdering) ||
      schema.propertyOrdering.some(
        (value) =>
          typeof value !== "string" ||
          !Object.hasOwn(schema.properties || {}, value),
      )
    ) {
      throw schemaError(
        `${path}.propertyOrdering`,
        "propertyOrdering е невалиден",
      );
    }
  }

  seen.delete(schema);
  return schema;
}

function normalizeVertexSchema(schema) {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "type"
        ? value.toUpperCase()
        : key === "properties"
          ? Object.fromEntries(
              Object.entries(value).map(([property, propertySchema]) => [
                property,
                normalizeVertexSchema(propertySchema),
              ]),
            )
          : key === "items"
            ? normalizeVertexSchema(value)
            : value,
    ]),
  );
}

export function validateVertexResponseSchema(schema) {
  return normalizeVertexSchema(
    validateSchemaNode(schema, "responseSchema", new WeakSet(), 0),
  );
}

function blockedResponse(data) {
  const blockReason = data?.promptFeedback?.blockReason;
  if (
    typeof blockReason === "string" &&
    blockReason.trim() &&
    blockReason !== "BLOCK_REASON_UNSPECIFIED"
  ) {
    return true;
  }
  return (Array.isArray(data?.candidates) ? data.candidates : []).some(
    (candidate) =>
      typeof candidate?.finishReason === "string" &&
      BLOCKED_FINISH_REASONS.has(candidate.finishReason.toUpperCase()),
  );
}

function responseError(status) {
  if (status === 401) {
    return new VertexAiGeminiError(
      "Vertex AI Gemini отхвърли автентикацията.",
      "VERTEX_GEMINI_UNAUTHORIZED",
      401,
    );
  }
  if (status === 403) {
    return new VertexAiGeminiError(
      "Vertex AI Gemini отказа достъпа на service account-а.",
      "VERTEX_GEMINI_FORBIDDEN",
      403,
    );
  }
  if (status === 429) {
    return new VertexAiGeminiError(
      "Vertex AI Gemini временно ограничи заявките.",
      "VERTEX_GEMINI_RATE_LIMITED",
      429,
    );
  }
  if (status >= 500 && status <= 599) {
    return new VertexAiGeminiError(
      "Vertex AI Gemini временно не е достъпен.",
      "VERTEX_GEMINI_UPSTREAM_5XX",
      status,
    );
  }
  return new VertexAiGeminiError(
    "Vertex AI Gemini върна грешка при заявката.",
    "VERTEX_GEMINI_UPSTREAM_ERROR",
    status >= 400 && status <= 499 ? status : 502,
  );
}

function timeoutError() {
  return new VertexAiGeminiError(
    "Vertex AI Gemini не отговори навреме.",
    "VERTEX_GEMINI_TIMEOUT",
    504,
  );
}

function clientAbortError() {
  return new VertexAiGeminiError(
    "Заявката към Vertex AI Gemini беше прекъсната от клиента.",
    "VERTEX_GEMINI_CLIENT_ABORT",
    499,
  );
}

function authError() {
  return new VertexAiGeminiError(
    "Vertex AI Gemini не можа да получи Google ADC автентикация.",
    "VERTEX_GEMINI_ADC_AUTH_FAILED",
    503,
  );
}

function invalidResponseError() {
  return new VertexAiGeminiError(
    "Vertex AI Gemini върна невалиден отговор.",
    "VERTEX_GEMINI_INVALID_RESPONSE",
    502,
  );
}

function emptyResponseError() {
  return new VertexAiGeminiError(
    "Vertex AI Gemini не върна текстов отговор.",
    "VERTEX_GEMINI_EMPTY_RESPONSE",
    502,
  );
}

function blockedResponseError() {
  return new VertexAiGeminiError(
    "Vertex AI Gemini блокира отговора според правилата за безопасност.",
    "VERTEX_GEMINI_BLOCKED_RESPONSE",
    502,
  );
}

function authorizationHeader(headers) {
  if (headers && typeof headers.get === "function") {
    const value = headers.get("authorization");
    return typeof value === "string" && value.trim() ? value : "";
  }
  const value = headers?.Authorization ?? headers?.authorization;
  return typeof value === "string" && value.trim() ? value : "";
}

async function loadAuthorizationHeader({
  endpoint,
  authClient,
  googleAuthFactory,
  clientFactory,
}) {
  let client = authClient;
  try {
    if (!client) {
      client = await createGoogleAuthClient({
        googleAuthFactory,
        clientFactory,
      });
    }
    const headers = await client.getRequestHeaders(endpoint);
    const authorization = authorizationHeader(headers);
    if (!authorization) throw new Error("ADC authorization header is missing");
    return authorization;
  } catch (error) {
    if (error instanceof VertexAiGeminiError) throw error;
    if (error instanceof GoogleAdcAuthError) throw authError();
    throw authError();
  }
}

function resolveRequestConfig(
  env,
  projectIdOverride,
  locationOverride,
  modelOverride,
  timeoutOverride,
) {
  const config = resolveVertexAiConfig(env);
  const projectId =
    projectIdOverride === undefined
      ? config.projectId
      : cleanValue(projectIdOverride);
  const location =
    locationOverride === undefined
      ? config.location
      : cleanValue(locationOverride);
  const model =
    modelOverride === undefined ? config.model : cleanValue(modelOverride);
  const invalidFields = [
    ...(isValidProjectId(projectId) ? [] : ["VERTEX_AI_PROJECT_ID"]),
    ...(isValidLocation(location) ? [] : ["VERTEX_AI_LOCATION"]),
    ...(isValidModel(model) ? [] : ["VERTEX_AI_MODEL"]),
  ];
  return {
    ...config,
    projectId,
    location,
    model,
    timeoutMs:
      timeoutOverride === undefined
        ? config.timeoutMs
        : resolveVertexAiTimeoutMs(timeoutOverride),
    invalidFields,
  };
}

export async function requestVertexAiGeminiResponse({
  env = process.env,
  input,
  projectId,
  location,
  model,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  signal,
  outputSchema,
  authClient,
  googleAuthFactory,
  clientFactory,
} = {}) {
  const config = resolveRequestConfig(
    env,
    projectId,
    location,
    model,
    timeoutMs,
  );
  if (!config.enabled) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini е изключен от конфигурацията.",
      "VERTEX_GEMINI_DISABLED",
      503,
    );
  }
  if (config.invalidFields.length) {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini конфигурацията е непълна или невалидна.",
      config.invalidFields.includes("VERTEX_AI_PROJECT_ID") && !config.projectId
        ? "VERTEX_GEMINI_NOT_CONFIGURED"
        : "VERTEX_GEMINI_CONFIG_INVALID",
      503,
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new VertexAiGeminiError(
      "Vertex AI Gemini fetch клиентът не е наличен.",
      "VERTEX_GEMINI_FETCH_UNAVAILABLE",
      503,
    );
  }
  if (signal?.aborted) throw clientAbortError();

  const endpoint = buildVertexAiGenerateContentEndpoint(config);
  const messages = normalizeVertexAiMessages(input);
  const systemMessages = messages
    .filter((item) => item.role === "system")
    .map((item) => item.content);
  const body = {
    ...(systemMessages.length
      ? {
          systemInstruction: {
            parts: [{ text: systemMessages.join("\n\n") }],
          },
        }
      : {}),
    contents: messages
      .filter((item) => item.role !== "system")
      .map((item) => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: item.content }],
      })),
  };
  if (outputSchema !== undefined) {
    body.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: validateVertexResponseSchema(outputSchema),
    };
  }

  const requestController = new AbortController();
  let timedOut = false;
  let clientAborted = false;
  let timeoutHandle;
  let rejectTimeout;
  let rejectClientAbort;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const clientAbortPromise = new Promise((_, reject) => {
    rejectClientAbort = reject;
  });
  const abortFromClient = () => {
    clientAborted = true;
    requestController.abort();
    rejectClientAbort(clientAbortError());
  };
  signal?.addEventListener("abort", abortFromClient, { once: true });
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    requestController.abort();
    rejectTimeout(timeoutError());
  }, config.timeoutMs);

  const operation = (async () => {
    const authorization = await loadAuthorizationHeader({
      endpoint,
      authClient,
      googleAuthFactory,
      clientFactory,
    });
    if (clientAborted) throw clientAbortError();

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify(body),
        signal: requestController.signal,
      });
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (clientAborted) throw clientAbortError();
      if (error instanceof VertexAiGeminiError) throw error;
      throw new VertexAiGeminiError(
        "Връзката с Vertex AI Gemini беше прекъсната.",
        "VERTEX_GEMINI_UPSTREAM_ERROR",
        502,
      );
    }

    if (!response || typeof response.ok !== "boolean") {
      throw invalidResponseError();
    }
    if (!response.ok) throw responseError(response.status);

    let data;
    try {
      data = await response.json();
    } catch {
      throw invalidResponseError();
    }
    if (blockedResponse(data)) throw blockedResponseError();
    const text = extractVertexAiOutputText(data);
    if (!text.trim()) throw emptyResponseError();

    return {
      text,
      provider: "vertex-gemini",
      model:
        typeof data?.modelVersion === "string" && data.modelVersion.trim()
          ? data.modelVersion.trim()
          : typeof data?.model === "string" && data.model.trim()
            ? data.model.trim()
            : config.model,
    };
  })();

  try {
    return await Promise.race([operation, timeoutPromise, clientAbortPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abortFromClient);
  }
}

export const requestVertexGeminiResponse = requestVertexAiGeminiResponse;
export const requestVertexAiResponse = requestVertexAiGeminiResponse;
