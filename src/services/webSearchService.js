const DEFAULT_MODEL = "gpt-4.1-mini";
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
  const message = Array.isArray(response?.output)
    ? response.output.find((item) => item?.type === "message")
    : null;
  const content = Array.isArray(message?.content)
    ? message.content.find((item) => item?.type === "output_text")
    : null;
  const text = typeof content?.text === "string" ? content.text.trim() : "";
  const sources = [];
  const seen = new Set();

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
  return { text, sources };
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
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.WEB_SEARCH_MODEL || DEFAULT_MODEL,
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
  if (!apiKey) {
    throw new WebSearchError(
      "Интернет търсенето не е конфигурирано.",
      503,
      "OPENAI_NOT_CONFIGURED",
    );
  }

  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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
    });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError(
      "Интернет търсенето беше прекъснато. Опитай пак.",
      502,
      "WEB_SEARCH_INTERRUPTED",
    );
  }

  if (!response.ok) {
    console.error(
      `[Web search] OpenAI upstream request failed: ${response.status}`,
    );
    throw new WebSearchError(
      "Интернет търсенето временно не е достъпно.",
      502,
      "WEB_SEARCH_UPSTREAM_ERROR",
    );
  }

  const result = extractSearchResult(await response.json());
  if (!result.text) {
    throw new WebSearchError(
      "Търсенето не върна отговор.",
      502,
      "EMPTY_WEB_SEARCH_RESPONSE",
    );
  }
  return result;
}
