import {
  fitPublicAiInput,
  publicAiOutputLimit,
  reservePublicAiCall,
} from "./publicAiBudget.js";
import {
  isVertexAiConfigured,
  requestVertexAiGeminiResponse,
  resolveVertexAiModel,
  resolveVertexAiTimeoutMs,
} from "./vertexAiGeminiService.js";
import { requestVertexOpenModel } from "./vertexOpenModelsService.js";

const DEFAULT_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const AI_PROVIDERS = new Set([
  "openai",
  "gemini",
  "grok",
  "claude",
  "vertex-gemini",
  "vertex-open",
]);

export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-4.1-mini";
export const DEFAULT_CODEX_COUNCIL_MODEL = "gpt-5.3-codex";
export const DEFAULT_OPENAI_PLANNER_MODEL = "gpt-4.1-mini";
export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GROK_CHAT_MODEL = "grok-3-mini";
export const DEFAULT_CLAUDE_CHAT_MODEL = "claude-haiku-5-5";
// Used when AI_CORE_PROVIDER is not set in Cloud Run. Keep provider and model
// choices here in code; only API keys belong in the runtime environment.
export const DEFAULT_AI_PROVIDER = "claude";

// Token usage of every successful AI call is handed to one recorder, set at
// startup (aiSpendService). It must never break or slow down a reply.
let aiUsageRecorder = null;
export function setAiUsageRecorder(recorder) {
  aiUsageRecorder = typeof recorder === "function" ? recorder : null;
}
export function reportAiUsage(provider, model, inputTokens, outputTokens) {
  return withUsage({ provider, model }, inputTokens, outputTokens).usage;
}
function withUsage(result, inputTokens, outputTokens) {
  const usage = {
    inputTokens: Math.max(0, Number(inputTokens) || 0),
    outputTokens: Math.max(0, Number(outputTokens) || 0),
  };
  if (!usage.inputTokens && !usage.outputTokens) return result;
  if (aiUsageRecorder) {
    try {
      Promise.resolve(
        aiUsageRecorder({ provider: result.provider, model: result.model, ...usage }),
      ).catch(() => {});
    } catch {
      // usage accounting is best effort
    }
  }
  return { ...result, usage };
}

export class AiCoreError extends Error {
  constructor(message, code = "AI_CORE_ERROR", status = 502) {
    super(message);
    this.name = "AiCoreError";
    this.code = code;
    this.status = status;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function normalizeChatMessages(input) {
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

export function extractOpenAIOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const text = (Array.isArray(data?.output) ? data.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((item) => item?.type === "output_text")
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .join("");

  return text;
}

export function extractGeminiOutputText(data) {
  return (Array.isArray(data?.candidates) ? data.candidates : [])
    .flatMap((candidate) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
    )
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

export function extractGrokOutputText(data) {
  return (Array.isArray(data?.choices) ? data.choices : [])
    .map((choice) => extractTextContent(choice?.message?.content))
    .join("");
}

// Only reasoning models (gpt-5 family, o-series, codex) accept the
// `reasoning` and `text.verbosity` parameters; older chat models such as
// gpt-4.1-mini reject them with HTTP 400.
export function supportsOpenAIReasoning(model) {
  return /^(gpt-5|o\d|codex)/iu.test(String(model || "").trim());
}

export async function requestOpenAIResponse({
  apiKey = process.env.OPENAI_API_KEY,
  responsesUrl = process.env.OPENAI_RESPONSES_URL ||
    DEFAULT_OPENAI_RESPONSES_URL,
  input,
  model = process.env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
  verbosity = "low",
  reasoningEffort = "none",
  outputSchema,
  outputSchemaName = "structured_response",
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "OpenAI не е конфигуриран.",
      "OPENAI_NOT_CONFIGURED",
      503,
    );
  }

  const schemaName = String(outputSchemaName || "structured_response")
    .replace(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, 64);
  const textOptions = {
    ...(verbosity && supportsOpenAIReasoning(model) ? { verbosity } : {}),
    ...(outputSchema && typeof outputSchema === "object"
      ? {
          format: {
            type: "json_schema",
            name: schemaName || "structured_response",
            strict: true,
            schema: outputSchema,
          },
        }
      : {}),
  };

  await reservePublicAiCall(input, "openai", model);
  const response = await fetchImpl(responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      ...(supportsOpenAIReasoning(model) && reasoningEffort
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
      ...(Object.keys(textOptions).length ? { text: textOptions } : {}),
      store: false,
      ...(publicAiOutputLimit()
        ? { max_output_tokens: publicAiOutputLimit() }
        : {}),
    }),
    signal,
  });

  if (!response.ok) {
    console.error(`[OpenAI] Upstream request failed: ${response.status}`);
    throw new AiCoreError(
      `OpenAI върна грешка ${response.status}.`,
      "OPENAI_UPSTREAM_ERROR",
      response.status,
    );
  }

  const data = await response.json();
  const text = extractOpenAIOutputText(data);
  if (!text.trim()) {
    throw new AiCoreError(
      "OpenAI не върна текстов отговор.",
      "OPENAI_EMPTY_RESPONSE",
    );
  }
  return withUsage(
    {
      text,
      ...(data?.incomplete_details?.reason === "max_output_tokens"
        ? { truncated: true }
        : {}),
      provider: "openai",
      model:
        typeof data?.model === "string" && data.model.trim()
          ? data.model.trim()
          : model,
    },
    data?.usage?.input_tokens,
    data?.usage?.output_tokens,
  );
}

export async function requestGeminiResponse({
  apiKey = process.env.GEMINI_API_KEY,
  apiUrl = process.env.GEMINI_API_URL || DEFAULT_GEMINI_API_URL,
  input,
  model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
  jsonMode = false,
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "Gemini не е конфигуриран.",
      "GEMINI_NOT_CONFIGURED",
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
  const baseUrl = String(apiUrl).replace(/\/+$/u, "");
  await reservePublicAiCall(input, "gemini", model);
  const response = await fetchImpl(
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        ...(systemMessages.length
          ? {
              systemInstruction: {
                parts: [{ text: systemMessages.join("\n\n") }],
              },
            }
          : {}),
        contents,
        ...(jsonMode || publicAiOutputLimit()
          ? {
              generationConfig: {
                ...(jsonMode ? { responseMimeType: "application/json" } : {}),
                ...(publicAiOutputLimit()
                  ? { maxOutputTokens: publicAiOutputLimit() }
                  : {}),
              },
            }
          : {}),
      }),
      signal,
    },
  );

  if (!response.ok) {
    console.error(`[Gemini] Upstream request failed: ${response.status}`);
    throw new AiCoreError(
      `Gemini върна грешка ${response.status}.`,
      "GEMINI_UPSTREAM_ERROR",
      response.status,
    );
  }

  const data = await response.json();
  const text = extractGeminiOutputText(data);
  if (!text.trim()) {
    throw new AiCoreError(
      "Gemini не върна текстов отговор.",
      "GEMINI_EMPTY_RESPONSE",
    );
  }
  return withUsage(
    {
      text,
      ...(data?.candidates?.[0]?.finishReason === "MAX_TOKENS"
        ? { truncated: true }
        : {}),
      provider: "gemini",
      model:
        typeof data?.modelVersion === "string" && data.modelVersion.trim()
          ? data.modelVersion.trim()
          : model,
    },
    data?.usageMetadata?.promptTokenCount,
    (Number(data?.usageMetadata?.candidatesTokenCount) || 0) +
      (Number(data?.usageMetadata?.thoughtsTokenCount) || 0),
  );
}

export async function requestGrokResponse({
  apiKey = process.env.GROK_API_KEY,
  apiUrl = process.env.GROK_API_URL || DEFAULT_GROK_API_URL,
  input,
  model = process.env.GROK_MODEL || DEFAULT_GROK_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
  jsonMode = false,
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "Grok не е конфигуриран.",
      "GROK_NOT_CONFIGURED",
      503,
    );
  }

  await reservePublicAiCall(input, "grok", model);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: normalizeChatMessages(input),
      stream: false,
      ...(publicAiOutputLimit() ? { max_tokens: publicAiOutputLimit() } : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    console.error(`[Grok] Upstream request failed: ${response.status}`);
    throw new AiCoreError(
      `Grok върна грешка ${response.status}.`,
      "GROK_UPSTREAM_ERROR",
      response.status,
    );
  }

  const data = await response.json();
  const text = extractGrokOutputText(data);
  if (!text.trim()) {
    throw new AiCoreError(
      "Grok не върна текстов отговор.",
      "GROK_EMPTY_RESPONSE",
    );
  }
  return withUsage(
    {
      text,
      ...(data?.choices?.[0]?.finish_reason === "length"
        ? { truncated: true }
        : {}),
      provider: "grok",
      model:
        typeof data?.model === "string" && data.model.trim()
          ? data.model.trim()
          : model,
    },
    data?.usage?.prompt_tokens,
    data?.usage?.completion_tokens,
  );
}

// Claude rejects (400) a conversation that starts with an assistant turn or
// ends with one (newer models do not support assistant prefill). Merge
// consecutive turns of the same role and keep the last turn from the user.
export function toClaudeMessages(normalized) {
  const merged = [];
  for (const { role, content } of normalized) {
    if (role === "system") continue;
    const claudeRole = role === "assistant" ? "assistant" : "user";
    const last = merged[merged.length - 1];
    if (last && last.role === claudeRole) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      merged.push({ role: claudeRole, content });
    }
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  while (merged.length && merged[merged.length - 1].role !== "user") merged.pop();
  return merged;
}

// Anthropic error bodies carry a type and a short message and never echo the
// API key, so they are safe to log and are what makes a 400 diagnosable.
async function describeClaudeError(response) {
  try {
    const body = await response.json();
    const type = String(body?.error?.type || "").slice(0, 60);
    const message = String(body?.error?.message || "")
      .replace(/sk-ant-[A-Za-z0-9_-]+/gu, "[key]")
      .slice(0, 300);
    return type || message ? ` ${type}: ${message}` : "";
  } catch {
    return "";
  }
}

export async function requestClaudeResponse({
  apiKey = process.env.ANTHROPIC_API_KEY,
  apiUrl = "https://api.anthropic.com/v1/messages",
  input,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
  maxTokens = 2048,
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "Claude не е конфигуриран.",
      "CLAUDE_NOT_CONFIGURED",
      503,
    );
  }
  const normalized = normalizeChatMessages(input);
  const system = normalized.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const messages = toClaudeMessages(normalized);
  if (!messages.length) {
    throw new AiCoreError(
      "Няма потребителско съобщение за Claude.",
      "CLAUDE_EMPTY_REQUEST",
      400,
    );
  }
  await reservePublicAiCall(input, "claude", model);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: publicAiOutputLimit() || maxTokens,
      ...(system ? { system } : {}),
      messages,
    }),
    signal,
  });
  if (!response.ok) {
    console.error(
      `[Claude] Upstream request failed: ${response.status}${await describeClaudeError(response)}`,
    );
    throw new AiCoreError(
      `Claude върна грешка ${response.status}.`,
      "CLAUDE_UPSTREAM_ERROR",
      response.status,
    );
  }
  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n")
        .trim()
    : "";
  if (!text)
    throw new AiCoreError(
      "Claude не върна текстов отговор.",
      "CLAUDE_EMPTY_RESPONSE",
    );
  return withUsage(
    {
      text,
      ...(data?.stop_reason === "max_tokens" ? { truncated: true } : {}),
      provider: "claude",
      model: data?.model || model,
    },
    (Number(data?.usage?.input_tokens) || 0) +
      (Number(data?.usage?.cache_read_input_tokens) || 0) +
      (Number(data?.usage?.cache_creation_input_tokens) || 0),
    data?.usage?.output_tokens,
  );
}

// GLM 5.2 costs several times more per answer than the economical models
// (about 1.8 US cents for a full context), so it takes two credits.
const VERTEX_OPEN_CREDITS = { "zai-org/glm-5.2-maas": 2 };
export const DEFAULT_VERTEX_OPEN_MODEL = "openai/gpt-oss-120b-maas";

async function requestVertexOpenResponse({
  input,
  model = DEFAULT_VERTEX_OPEN_MODEL,
  env = process.env,
  maxTokens = 2048,
  fetchImpl,
  authClient,
  signal,
} = {}) {
  await reservePublicAiCall(input, "vertex-open", model, VERTEX_OPEN_CREDITS[model] || 1);
  const result = await requestVertexOpenModel({
    env,
    model,
    location: "global",
    input,
    maxTokens: publicAiOutputLimit() || maxTokens,
    timeoutMs: 60_000,
    signal,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(authClient ? { authClient } : {}),
  });
  const { usage, ...rest } = result;
  return withUsage(rest, usage?.inputTokens, usage?.outputTokens);
}

export function normalizeAiProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AI_PROVIDERS.has(provider) ? provider : null;
}

export function getConfiguredAiProvider(env = process.env) {
  const configuredProvider = env.AI_CORE_PROVIDER;
  if (configuredProvider === undefined || configuredProvider === "") {
    return DEFAULT_AI_PROVIDER;
  }
  return normalizeAiProvider(configuredProvider);
}

export function isAiProviderConfigured(provider, env = process.env) {
  switch (normalizeAiProvider(provider)) {
    case "openai":
      return Boolean(env.OPENAI_API_KEY);
    case "gemini":
      return Boolean(env.GEMINI_API_KEY);
    case "grok":
      return Boolean(env.GROK_API_KEY);
    case "claude":
      return Boolean(env.ANTHROPIC_API_KEY);
    case "vertex-gemini":
    case "vertex-open":
      return isVertexAiConfigured(env);
    default:
      return false;
  }
}

export function isAiCoreConfigured(env = process.env) {
  const provider = getConfiguredAiProvider(env);
  return Boolean(provider && isAiProviderConfigured(provider, env));
}

export function hasConfiguredAiProvider(env = process.env) {
  return [...AI_PROVIDERS].some((provider) =>
    isAiProviderConfigured(provider, env),
  );
}

export function getAiProviderStatus(env = process.env) {
  const selectedProvider = getConfiguredAiProvider(env);
  const providers = [...AI_PROVIDERS].map((id) => ({
    id,
    configured: isAiProviderConfigured(id, env),
  }));
  return {
    selectedProvider,
    primaryProvider: selectedProvider,
    configured: Boolean(
      selectedProvider && isAiProviderConfigured(selectedProvider, env),
    ),
    providers,
  };
}

export function getAiProviderTimeoutMs(
  provider,
  env = process.env,
  fallback = DEFAULT_AI_TIMEOUT_MS,
) {
  const timeoutKey = {
    openai: "OPENAI_TIMEOUT_MS",
    gemini: "GEMINI_TIMEOUT_MS",
    grok: "GROK_TIMEOUT_MS",
    claude: "ANTHROPIC_TIMEOUT_MS",
  }[normalizeAiProvider(provider)];
  if (normalizeAiProvider(provider) === "vertex-gemini") {
    return resolveVertexAiTimeoutMs(env);
  }
  return parsePositiveInteger(
    timeoutKey ? env[timeoutKey] : undefined,
    fallback,
  );
}

export function getDefaultChatModel(provider, env = process.env) {
  return {
    openai: env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL,
    gemini: env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL,
    grok: env.GROK_MODEL || DEFAULT_GROK_CHAT_MODEL,
    claude: env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CHAT_MODEL,
    "vertex-gemini": resolveVertexAiModel(env),
    "vertex-open": DEFAULT_VERTEX_OPEN_MODEL,
  }[provider];
}

export async function requestAiResponse({ provider, ...options } = {}) {
  const selectedProvider =
    provider === undefined
      ? getConfiguredAiProvider(options.env || process.env)
      : normalizeAiProvider(provider);
  if (!selectedProvider) {
    throw new AiCoreError(
      "AI доставчикът е невалидно конфигуриран.",
      "AI_PROVIDER_INVALID",
      503,
    );
  }

  if (publicAiOutputLimit() && selectedProvider === "vertex-gemini")
    throw new AiCoreError(
      "Този двигател не е включен в потребителските планове.",
      "PUBLIC_PROVIDER_UNAVAILABLE",
      403,
    );

  if (publicAiOutputLimit()) options.input = fitPublicAiInput(options.input);

  switch (selectedProvider) {
    case "openai":
      return requestOpenAIResponse(options);
    case "gemini":
      return requestGeminiResponse(options);
    case "grok":
      return requestGrokResponse(options);
    case "claude":
      return requestClaudeResponse(options);
    case "vertex-gemini":
      return requestVertexAiGeminiResponse(options);
    case "vertex-open":
      return requestVertexOpenResponse(options);
    default:
      throw new AiCoreError(
        "AI доставчикът не е разрешен.",
        "AI_PROVIDER_UNSUPPORTED",
        503,
      );
  }
}

export async function requestAiText(options) {
  const response = await requestAiResponse(options);
  return response.text;
}

export async function requestOpenAIText(options) {
  const response = await requestOpenAIResponse(options);
  return response.text;
}
