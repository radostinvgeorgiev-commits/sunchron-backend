import { createGoogleAuthClient } from "./googleAdcAuth.js";
import { resolveVertexAiConfig } from "./vertexAiGeminiService.js";

// Open models (Llama, DeepSeek, Qwen, gpt-oss…) that Google serves in Vertex
// AI Model Garden and bills to the owner's Google Cloud project. They share
// one OpenAI-style endpoint; each model lives in its own regions, so every
// entry lists where to try it, first one first.
export const VERTEX_OPEN_MODEL_CANDIDATES = Object.freeze([
  { model: "meta/llama-4-maverick-17b-128e-instruct-maas", label: "Llama 4 Maverick", locations: ["us-east5", "global"] },
  { model: "meta/llama-3.3-70b-instruct-maas", label: "Llama 3.3 70B", locations: ["us-central1", "global"] },
  { model: "deepseek-ai/deepseek-v3.1-maas", label: "DeepSeek V3.1", locations: ["global", "us-west2"] },
  { model: "qwen/qwen3-235b-a22b-instruct-2507-maas", label: "Qwen3 235B", locations: ["global", "us-south1"] },
  { model: "openai/gpt-oss-120b-maas", label: "gpt-oss 120B", locations: ["global", "us-central1"] },
]);

const DEFAULT_TIMEOUT_MS = 20_000;

export class VertexOpenModelError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = "VertexOpenModelError";
    this.code = code;
    this.status = status;
  }
}

export function buildVertexOpenModelEndpoint({ projectId, location }) {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/endpoints/openapi/chat/completions`;
}

function errorFor(status) {
  if (status === 404) return new VertexOpenModelError("Моделът не е наличен в този регион.", "VERTEX_OPEN_MODEL_NOT_FOUND", 404);
  if (status === 403) return new VertexOpenModelError("Моделът не е включен за проекта.", "VERTEX_OPEN_MODEL_FORBIDDEN", 403);
  if (status === 429) return new VertexOpenModelError("Моделът временно ограничи заявките.", "VERTEX_OPEN_MODEL_RATE_LIMITED", 429);
  if (status === 400) return new VertexOpenModelError("Моделът отказа заявката.", "VERTEX_OPEN_MODEL_BAD_REQUEST", 400);
  return new VertexOpenModelError("Моделът върна грешка.", "VERTEX_OPEN_MODEL_UPSTREAM_ERROR", status >= 500 ? 502 : status || 502);
}

export async function requestVertexOpenModel({
  env = process.env,
  model,
  location,
  input,
  maxTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  authClient,
} = {}) {
  const config = resolveVertexAiConfig(env);
  if (!config.enabled || !config.projectId) {
    throw new VertexOpenModelError("Vertex AI не е включен.", "VERTEX_OPEN_MODEL_DISABLED", 503);
  }
  const endpoint = buildVertexOpenModelEndpoint({ projectId: config.projectId, location });
  const client = authClient || (await createGoogleAuthClient());
  const headers = await client.getRequestHeaders(endpoint);
  const authorization = headers?.Authorization || headers?.authorization || (typeof headers?.get === "function" ? headers.get("authorization") : "");
  if (!authorization) throw new VertexOpenModelError("Няма Google вход за Vertex.", "VERTEX_OPEN_MODEL_AUTH_FAILED", 503);

  const messages = (Array.isArray(input) ? input : [{ role: "user", content: String(input || "") }])
    .map(({ role, content }) => ({
      role: role === "assistant" || role === "system" ? role : "user",
      content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
    }))
    .filter(({ content }) => content.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ model, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
      signal: controller.signal,
    });
  } catch {
    throw new VertexOpenModelError("Моделът не отговори навреме.", "VERTEX_OPEN_MODEL_TIMEOUT", 504);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw errorFor(response.status);
  const data = await response.json().catch(() => null);
  const choice = data?.choices?.[0];
  const text = String(choice?.message?.content || "").trim();
  if (!text) throw new VertexOpenModelError("Моделът върна празен отговор.", "VERTEX_OPEN_MODEL_EMPTY", 502);
  return { text, provider: "vertex-open", model, truncated: choice?.finish_reason === "length" };
}

// Asks every candidate a tiny question and reports which ones answer, and
// from which region. Used by the self-test to learn what can be offered.
export async function probeVertexOpenModels({ env = process.env, ask = requestVertexOpenModel, marker = "7" } = {}) {
  return Promise.all(
    VERTEX_OPEN_MODEL_CANDIDATES.map(async ({ model, label, locations }) => {
      const errors = [];
      for (const location of locations) {
        try {
          const { text } = await ask({
            env,
            model,
            location,
            input: [{ role: "user", content: `Отговори само с числото ${marker}.` }],
            maxTokens: 200,
          });
          return { model, label, location, ok: String(text).includes(marker) };
        } catch (error) {
          errors.push(`${location}:${error?.code || "error"}`);
        }
      }
      return { model, label, ok: false, errors };
    }),
  );
}
