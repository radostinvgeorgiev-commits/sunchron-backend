const DEFAULT_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_AI_TIMEOUT_MS = 120_000;
const AI_PROVIDERS = new Set(["openai", "gemini", "grok", "anthropic"]);

export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENAI_PLANNER_MODEL = "gpt-5.6-luna";
export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash";
export const DEFAULT_GROK_CHAT_MODEL = "grok-3-mini";
export const DEFAULT_ANTHROPIC_CHAT_MODEL = "claude-sonnet-5";
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 2_048;

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

function parseBoundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  const selected = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, selected));
}

function normalizeAnthropicEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["low", "medium", "high", "max"].includes(effort) ? effort : "low";
}

function safeTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return [part.text, part.input_text, part.output_text].find(
        (value) => typeof value === "string",
      ) || "";
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

export function extractAnthropicOutputText(data) {
  return (Array.isArray(data?.content) ? data.content : [])
    .filter((part) => part?.type === "text")
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

export async function requestOpenAIResponse({
  apiKey = process.env.OPENAI_API_KEY,
  responsesUrl =
    process.env.OPENAI_RESPONSES_URL || DEFAULT_OPENAI_RESPONSES_URL,
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
    verbosity,
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

  const response = await fetchImpl(responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      reasoning: { effort: reasoningEffort },
      text: textOptions,
      store: false,
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
  return {
    text,
    provider: "openai",
    model:
      typeof data?.model === "string" && data.model.trim()
        ? data.model.trim()
        : model,
  };
}

export async function requestGeminiResponse({
  apiKey = process.env.GEMINI_API_KEY,
  apiUrl = process.env.GEMINI_API_URL || DEFAULT_GEMINI_API_URL,
  input,
  model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
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
  return {
    text,
    provider: "gemini",
    model:
      typeof data?.modelVersion === "string" && data.modelVersion.trim()
        ? data.modelVersion.trim()
        : model,
  };
}

export async function requestGrokResponse({
  apiKey = process.env.GROK_API_KEY,
  apiUrl = process.env.GROK_API_URL || DEFAULT_GROK_API_URL,
  input,
  model = process.env.GROK_MODEL || DEFAULT_GROK_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "Grok не е конфигуриран.",
      "GROK_NOT_CONFIGURED",
      503,
    );
  }

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
  return {
    text,
    provider: "grok",
    model:
      typeof data?.model === "string" && data.model.trim()
        ? data.model.trim()
        : model,
  };
}


export async function requestAnthropicResponse({
  apiKey = process.env.ANTHROPIC_API_KEY,
  apiUrl = DEFAULT_ANTHROPIC_MESSAGES_URL,
  apiVersion = DEFAULT_ANTHROPIC_API_VERSION,
  input,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_CHAT_MODEL,
  maxTokens =
    process.env.ANTHROPIC_MAX_TOKENS || DEFAULT_ANTHROPIC_MAX_TOKENS,
  effort = process.env.ANTHROPIC_EFFORT || "low",
  fetchImpl = fetch,
  signal,
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "Anthropic не е конфигуриран.",
      "ANTHROPIC_NOT_CONFIGURED",
      503,
    );
  }

  const normalized = normalizeChatMessages(input);
  const system = normalized
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n\n");
  const messages = normalized
    .filter((item) => item.role !== "system")
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content,
    }));
  if (!messages.some((item) => item.role === "user")) {
    throw new AiCoreError(
      "Anthropic изисква потребителско съобщение.",
      "ANTHROPIC_INVALID_INPUT",
      400,
    );
  }
  if (messages.at(-1)?.role === "assistant") {
    throw new AiCoreError(
      "Anthropic не приема assistant prefill в този разговорен режим.",
      "ANTHROPIC_ASSISTANT_PREFILL_UNSUPPORTED",
      400,
    );
  }

  const boundedMaxTokens = parseBoundedInteger(
    maxTokens,
    DEFAULT_ANTHROPIC_MAX_TOKENS,
    256,
    8_192,
  );
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": apiVersion,
    },
    body: JSON.stringify({
      model,
      max_tokens: boundedMaxTokens,
      ...(system ? { system } : {}),
      messages,
      output_config: { effort: normalizeAnthropicEffort(effort) },
      service_tier: "standard_only",
      stream: false,
    }),
    signal,
  });

  const requestId = response.headers.get("request-id");
  if (!response.ok) {
    console.error(
      `[Anthropic] Upstream request failed: ${response.status}` +
        (requestId ? ` request-id=${requestId}` : ""),
    );
    throw new AiCoreError(
      `Anthropic върна грешка ${response.status}.`,
      "ANTHROPIC_UPSTREAM_ERROR",
      response.status,
    );
  }

  const data = await response.json();
  const stopReason =
    typeof data?.stop_reason === "string" ? data.stop_reason : null;
  if (stopReason === "refusal") {
    throw new AiCoreError(
      "Anthropic отказа заявката.",
      "ANTHROPIC_REFUSAL",
      422,
    );
  }
  if (stopReason === "model_context_window_exceeded") {
    throw new AiCoreError(
      "Контекстът е прекалено голям за Anthropic.",
      "ANTHROPIC_CONTEXT_TOO_LARGE",
      413,
    );
  }
  if (stopReason !== "end_turn") {
    throw new AiCoreError(
      "Anthropic не завърши отговора.",
      "ANTHROPIC_INCOMPLETE_RESPONSE",
    );
  }

  const text = extractAnthropicOutputText(data);
  if (!text.trim()) {
    throw new AiCoreError(
      "Anthropic не върна текстов отговор.",
      "ANTHROPIC_EMPTY_RESPONSE",
    );
  }
  return {
    text,
    provider: "anthropic",
    model:
      typeof data?.model === "string" && data.model.trim()
        ? data.model.trim()
        : model,
    stopReason,
    requestId: requestId || null,
    usage: {
      inputTokens: safeTokenCount(data?.usage?.input_tokens),
      outputTokens: safeTokenCount(data?.usage?.output_tokens),
      cacheCreationInputTokens: safeTokenCount(
        data?.usage?.cache_creation_input_tokens,
      ),
      cacheReadInputTokens: safeTokenCount(
        data?.usage?.cache_read_input_tokens,
      ),
      thinkingTokens: safeTokenCount(
        data?.usage?.output_tokens_details?.thinking_tokens,
      ),
    },
  };
}

export function normalizeAiProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AI_PROVIDERS.has(provider) ? provider : null;
}

export function getConfiguredAiProvider(env = process.env) {
  const configuredProvider = env.AI_CORE_PROVIDER;
  if (configuredProvider === undefined || configuredProvider === "") {
    return "openai";
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
    case "anthropic":
      return Boolean(env.ANTHROPIC_API_KEY);
    default:
      return false;
  }
}

export function isAiCoreConfigured(env = process.env) {
  const provider = getConfiguredAiProvider(env);
  return Boolean(provider && isAiProviderConfigured(provider, env));
}

export function getAiProviderStatus(env = process.env) {
  const selectedProvider = getConfiguredAiProvider(env);
  const providers = ["openai", "gemini", "grok", "anthropic"].map((id) => ({
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
    anthropic: "ANTHROPIC_TIMEOUT_MS",
  }[normalizeAiProvider(provider)];
  return parsePositiveInteger(timeoutKey ? env[timeoutKey] : undefined, fallback);
}

export async function requestAiResponse({
  provider,
  ...options
} = {}) {
  const selectedProvider =
    provider === undefined
      ? getConfiguredAiProvider()
      : normalizeAiProvider(provider);
  if (!selectedProvider) {
    throw new AiCoreError(
      "AI доставчикът е невалидно конфигуриран.",
      "AI_PROVIDER_INVALID",
      503,
    );
  }

  switch (selectedProvider) {
    case "openai":
      return requestOpenAIResponse(options);
    case "gemini":
      return requestGeminiResponse(options);
    case "grok":
      return requestGrokResponse(options);
    case "anthropic":
      return requestAnthropicResponse(options);
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
