import { requestAiResponse } from "./novariumService.js";
import { isVertexAiConfigured, resolveVertexAiModel } from "./vertexAiGeminiService.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
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
    env = process.env,
    model = env.WEB_SEARCH_MODEL || resolveVertexAiModel(env) || DEFAULT_GEMINI_MODEL,
    signal = AbortSignal.timeout(60000),
    authClient,
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
  if (!isVertexAiConfigured(env)) {
    throw new WebSearchError(
      "Интернет търсенето не е конфигурирано.",
      503,
      "WEB_SEARCH_NOT_CONFIGURED",
    );
  }
  try {
    const response = await requestAiResponse({
      provider: "vertex-gemini",
      env,
      model,
      input: [{
        role: "user",
        content: [
          "Отговори на български език.",
          "Направи актуално интернет търсене и дай ясен, практичен отговор.",
          "Не измисляй факти. Използвай видими и проверими източници.",
          "",
          cleanQuery,
        ].join("\n"),
      }],
      fetchImpl,
      signal,
      authClient,
      tools: [{ googleSearch: {} }],
      maxOutputTokens: 4096,
    });
    return {
      text: String(response?.text || "").trim(),
      sources: [],
    };
  } catch (error) {
    console.error(
      `[Web search] Vertex failed: ${error?.code || error?.name || "error"} ${error?.status ?? ""}`.trim(),
    );
    throw new WebSearchError(
      "Интернет търсенето временно не е достъпно.",
      502,
      "WEB_SEARCH_UPSTREAM_ERROR",
    );
  }
}
