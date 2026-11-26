import { createGoogleAuthClient } from "./googleAdcAuth.js";
import { resolveVertexAiConfig } from "./vertexAiGeminiService.js";

// Open models (Llama, DeepSeek, Qwen, gpt-oss…) that Google serves in Vertex
// AI Model Garden and bills to the owner's Google Cloud project. They share
// one OpenAI-style endpoint; each model lives in its own regions, so every
// entry lists where to try it, first one first.
export const VERTEX_OPEN_MODEL_CANDIDATES = Object.freeze([
  { model: "meta/llama-4-maverick-17b-128e-instruct-maas", label: "Llama 4 Maverick", locations: ["us-east5", "global"] },
  { model: "meta/llama-4-scout-17b-16e-instruct-maas", label: "Llama 4 Scout", locations: ["us-east5", "global"] },
  { model: "deepseek-ai/deepseek-v4.1-flash-maas", label: "DeepSeek V4.1 Flash", locations: ["global"] },
  { model: "openai/gpt-oss-120b-maas", label: "gpt-oss 120B", locations: ["global", "us-central1"] },
  { model: "google/gemma-4-26b-a4b-it-maas", label: "Gemma 4 26B", locations: ["global"] },
  { model: "zai-org/glm-5.2-maas", label: "GLM 5.2", locations: ["global"] },
]);

const DEFAULT_TIMEOUT_MS = 10_000;
// The self-test gives each row 30 s; the whole probe stays well under that.
const PROBE_BUDGET_MS = 24_000;

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

// Google's own reason (e.g. SERVICE_DISABLED, IAM_PERMISSION_DENIED, a
// policy or a model that is not enabled) and a short message, so the
// self-test says what to change. Never contains credentials.
async function googleReason(response) {
  try {
    const data = await response.json();
    const error = Array.isArray(data) ? data[0]?.error : data?.error;
    const details = Array.isArray(error?.details) ? error.details : [];
    const reason = details.map((item) => item?.reason).find(Boolean) || error?.status || "";
    const message = String(error?.message || "").replace(/\s+/gu, " ").slice(0, 120);
    return [reason, message].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}

function errorFor(status, reason = "") {
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
  if (!response.ok) {
    const reason = await googleReason(response);
    const error = errorFor(response.status, reason);
    error.reason = reason;
    throw error;
  }
  const data = await response.json().catch(() => null);
  const choice = data?.choices?.[0];
  const text = String(choice?.message?.content || "").trim();
  if (!text) throw new VertexOpenModelError("Моделът върна празен отговор.", "VERTEX_OPEN_MODEL_EMPTY", 502);
  return { text, provider: "vertex-open", model, truncated: choice?.finish_reason === "length" };
}

// Asks every candidate a tiny question and reports which ones answer, and
// from which region. Used by the self-test to learn what can be offered.
export async function probeVertexOpenModels({
  env = process.env,
  ask = requestVertexOpenModel,
  marker = "7",
  budgetMs = PROBE_BUDGET_MS,
} = {}) {
  const deadline = Date.now() + budgetMs;
  return Promise.all(
    VERTEX_OPEN_MODEL_CANDIDATES.map(async ({ model, label, locations }) => {
      const errors = [];
      for (const location of locations) {
        const left = deadline - Date.now();
        if (left < 2_000) {
          errors.push(`${location}:не стигна времето`);
          continue;
        }
        try {
          const { text } = await ask({
            env,
            model,
            location,
            input: [{ role: "user", content: `Отговори само с числото ${marker}.` }],
            maxTokens: 200,
            timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, left - 1_000),
          });
          return { model, label, location, ok: String(text).includes(marker) };
        } catch (error) {
          errors.push(`${location}:${error?.code || "error"}${error?.reason ? ` (${error.reason})` : ""}`);
        }
      }
      return { model, label, ok: false, errors };
    }),
  );
}
