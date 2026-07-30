const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

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

export async function requestOpenAIText({
  apiKey = process.env.OPENAI_API_KEY,
  input,
  model = process.env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL,
  fetchImpl = fetch,
  signal,
  verbosity = "low",
  reasoningEffort = "none",
}) {
  if (!apiKey) {
    throw new AiCoreError(
      "OpenAI не е конфигуриран.",
      "OPENAI_NOT_CONFIGURED",
      503,
    );
  }

  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      reasoning: { effort: reasoningEffort },
      text: { verbosity },
      store: false,
    }),
    signal,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    console.error(`[OpenAI] ${response.status}:`, responseBody || "<empty>");
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
  return text;
}
