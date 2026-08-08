const DEFAULT_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENAI_PLANNER_MODEL = "gpt-5.6-luna";

export class AiCoreError extends Error {
  constructor(message, code = "AI_CORE_ERROR", status = 502) {
    super(message);
    this.name = "AiCoreError";
    this.code = code;
    this.status = status;
  }
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

export async function requestOpenAIText(options) {
  const response = await requestOpenAIResponse(options);
  return response.text;
}
