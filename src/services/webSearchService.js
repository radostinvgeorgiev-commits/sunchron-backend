const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const MAX_QUERY_LENGTH = 1500;

export class WebSearchError extends Error {
  constructor(message, status = 502, code = "WEB_SEARCH_ERROR") {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
    this.code = code;
  }
}

export function isWebSearchRequest(message) {
  if (typeof message !== "string") return false;
  const text = message.trim().toLowerCase();
  if (!text) return false;

  return (
    /(?:потърси|провери|намери|покажи).*(?:в интернет|в мрежата|онлайн)/iu.test(
      text,
    ) ||
    /(?:актуалн(?:о|ото|а|ата|и|ите)|днешн(?:о|ото|а|ата|и|ите))\s+(?:време|прогноза|новини|цена|курс|резултат)/iu.test(
      text,
    ) ||
    /\bweb\s*search\b|\binternet\s*search\b/iu.test(text)
  );
}

export function extractSearchResult(response) {
  const text = extractGeminiText(response) || extractOpenAiText(response);
  const chunks = Array.isArray(response?.candidates)
    ? response.candidates[0]?.groundingMetadata?.groundingChunks
    : null;
  const sources = [];
  const seen = new Set();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const source = chunk?.web;
    if (!source?.uri || seen.has(source.uri)) continue;
    seen.add(source.uri);
    sources.push({
      title: source.title || source.uri,
      url: source.uri,
    });
  }
  if (!sources.length) {
    const message = Array.isArray(response?.output)
      ? response.output.find((item) => item?.type === "message")
      : null;
    const content = Array.isArray(message?.content)
      ? message.content.find((item) => item?.type === "output_text")
      : null;
    for (const annotation of content?.annotations || []) {
      if (annotation?.type !== "url_citation") continue;
      const citation = annotation.url_citation || annotation;
      if (!citation.url || seen.has(citation.url)) continue;
      seen.add(citation.url);
      sources.push({
        title: citation.title || citation.url,
        url: citation.url,
      });
    }
  }
  return { text, sources };
}

function extractGeminiText(response) {
  return (Array.isArray(response?.candidates)
    ? response.candidates[0]?.content?.parts
    : []
  )
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function extractOpenAiText(response) {
  const message = Array.isArray(response?.output)
    ? response.output.find((item) => item?.type === "message")
    : null;
  const content = Array.isArray(message?.content)
    ? message.content.find((item) => item?.type === "output_text")
    : null;
  return typeof content?.text === "string" ? content.text.trim() : "";
}

export function formatWebSearchResult(result) {
  const sourceLines = result.sources.map(
    ({ title, url }) => `• [${title}](${url})`,
  );
  return [result.text, sourceLines.length ? "Източници:" : "", ...sourceLines]
    .filter(Boolean)
    .join("\n");
}

export async function searchWeb(
  query,
  {
    fetchImpl = fetch,
    geminiApiKey = process.env.GEMINI_API_KEY,
    openAiApiKey = process.env.OPENAI_API_KEY,
    model = process.env.WEB_SEARCH_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    geminiBaseUrl = process.env.GEMINI_API_URL ||
      "https://generativelanguage.googleapis.com/v1beta",
    openAiModel = process.env.OPENAI_WEB_SEARCH_MODEL || DEFAULT_OPENAI_MODEL,
    signal = AbortSignal.timeout(60000),
  } = {},
) {
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    throw new WebSearchError(
      "Напиши какво да потърся.",
      400,
      "EMPTY_SEARCH_QUERY",
    );
  }
  if (cleanQuery.length > MAX_QUERY_LENGTH) {
    throw new WebSearchError(
      "Търсенето е прекалено дълго.",
      400,
      "SEARCH_QUERY_TOO_LONG",
    );
  }
  if (!geminiApiKey && !openAiApiKey) {
    throw new WebSearchError(
      "Интернет търсенето не е конфигурирано.",
      503,
      "WEB_SEARCH_NOT_CONFIGURED",
    );
  }

  const requests = [
    geminiApiKey
      ? () =>
          fetchImpl(
            `${String(geminiBaseUrl).replace(/\/+$/u, "")}/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": geminiApiKey,
              },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: [
                          "Отговори на български език.",
                          "Направи актуално интернет търсене и дай ясен, практичен отговор.",
                          "Не измисляй факти. Използвай видими и проверими източници.",
                          "",
                          cleanQuery,
                        ].join("\n"),
                      },
                    ],
                  },
                ],
                tools: [{ googleSearch: {} }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
              }),
              signal,
            },
          )
      : null,
    openAiApiKey
      ? () =>
          fetchImpl("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openAiApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: openAiModel,
              tools: [{ type: "web_search", search_context_size: "medium" }],
              tool_choice: "required",
              input: [
                "Отговори на български език.",
                "Направи актуално интернет търсене и дай ясен, практичен отговор.",
                "Не измисляй факти. Използвай видими и проверими източници.",
                "",
                cleanQuery,
              ].join("\n"),
            }),
            signal,
          })
      : null,
  ].filter(Boolean);

  let lastError;
  for (const request of requests) {
    let response;
    try {
      response = await request();
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) {
      console.error(`[Web search] Upstream request failed: ${response.status}`);
      lastError = new WebSearchError(
        "Интернет търсенето временно не е достъпно.",
        502,
        "WEB_SEARCH_UPSTREAM_ERROR",
      );
      continue;
    }
    const result = extractSearchResult(await response.json());
    if (!result.text) {
      lastError = new WebSearchError(
        "Търсенето не върна отговор.",
        502,
        "EMPTY_WEB_SEARCH_RESPONSE",
      );
      continue;
    }
    return result;
  }
  if (lastError instanceof WebSearchError) throw lastError;
  throw new WebSearchError(
    "Интернет търсенето беше прекъснато. Опитай пак.",
    502,
    "WEB_SEARCH_INTERRUPTED",
  );
}
