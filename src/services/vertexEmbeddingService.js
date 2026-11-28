import { createGoogleAuthClient } from "./googleAdcAuth.js";
import { isVertexAiConfigured, resolveVertexAiConfig } from "./vertexAiGeminiService.js";

export const DEFAULT_VERTEX_EMBEDDING_MODEL = "text-embedding-004";

export class VertexEmbeddingError extends Error {
  constructor(message, code = "VERTEX_EMBEDDING_ERROR", status = 502) {
    super(message);
    this.name = "VertexEmbeddingError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, limit = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function buildVertexEmbeddingEndpoint(config, model = DEFAULT_VERTEX_EMBEDDING_MODEL) {
  if (!config?.configured) throw new VertexEmbeddingError("Vertex AI embeddings не е конфигуриран.", "VERTEX_EMBEDDING_NOT_CONFIGURED", 503);
  const host = config.location === "global"
    ? "aiplatform.googleapis.com"
    : `${config.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
}

export async function requestVertexEmbeddings({
  texts,
  env = process.env,
  model = env.VERTEX_EMBEDDING_MODEL || DEFAULT_VERTEX_EMBEDDING_MODEL,
  fetchImpl = globalThis.fetch,
  authClient,
  googleAuthFactory,
  clientFactory,
  signal,
} = {}) {
  const config = resolveVertexAiConfig(env);
  if (!isVertexAiConfigured(env)) {
    throw new VertexEmbeddingError("Vertex AI embeddings не е конфигуриран.", "VERTEX_EMBEDDING_NOT_CONFIGURED", 503);
  }
  const cleanTexts = (Array.isArray(texts) ? texts : [])
    .map((text) => cleanText(text))
    .filter(Boolean);
  if (!cleanTexts.length) return [];
  if (typeof fetchImpl !== "function") {
    throw new VertexEmbeddingError("Embedding fetch клиентът не е наличен.", "VERTEX_EMBEDDING_FETCH_UNAVAILABLE", 503);
  }

  const authorization = authClient || await createGoogleAuthClient({ googleAuthFactory, clientFactory });
  const headers = await authorization.getRequestHeaders();
  const response = await fetchImpl(buildVertexEmbeddingEndpoint(config, model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])),
    },
    body: JSON.stringify({
      instances: cleanTexts.map((content) => ({ content })),
      parameters: { autoTruncate: true },
    }),
    signal,
  });
  if (!response.ok) {
    throw new VertexEmbeddingError(`Vertex embeddings върна грешка ${response.status}.`, "VERTEX_EMBEDDING_UPSTREAM", response.status);
  }
  const data = await response.json();
  return (Array.isArray(data?.predictions) ? data.predictions : [])
    .map((prediction) => prediction?.embeddings?.values)
    .filter((values) => Array.isArray(values));
}
