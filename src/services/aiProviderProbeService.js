import { requestAiResponse } from "./novariumService.js";

// A key being present says nothing about whether the provider answers: the
// model may be retired (404), overloaded (503) or the account out of credit
// (Anthropic 400). This sends one tiny real request per provider and caches
// the outcome, so status reports describe what actually works.

const PROBE_PROVIDERS = Object.freeze([
  { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY"] },
  { id: "gemini", label: "Gemini", keys: ["GEMINI_API_KEY"] },
  { id: "grok", label: "Grok", keys: ["GROK_API_KEY"] },
  { id: "claude", label: "Claude", keys: ["ANTHROPIC_API_KEY"] },
]);
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_INPUT = Object.freeze([
  { role: "user", content: "Отговори само с думата: ok" },
]);

const cache = new Map();

function hasKey(env, keys) {
  return keys.every((key) => typeof env[key] === "string" && env[key].trim());
}

function describeFailure(error) {
  const status = Number(error?.status) || null;
  const code = typeof error?.code === "string" ? error.code : "PROBE_FAILED";
  let reason = "не отговаря";
  if (status === 401 || status === 403) reason = "ключът е отказан";
  else if (status === 404) reason = "моделът не съществува";
  else if (status === 429) reason = "лимит или няма кредит";
  else if (status === 503 || status === 529) reason = "претоварен";
  else if (status === 400) reason = "заявката е отказана (често няма кредит)";
  else if (code.includes("TIMEOUT")) reason = "не отговори навреме";
  return { status, code, reason };
}

export function resetAiProviderProbeCache() {
  cache.clear();
}

export async function probeAiProviders({
  env = process.env,
  request = requestAiResponse,
  now = Date.now,
  force = false,
} = {}) {
  return Promise.all(
    PROBE_PROVIDERS.map(async ({ id, label, keys }) => {
      if (!hasKey(env, keys)) {
        return { id, label, configured: false, working: false, reason: "няма ключ" };
      }
      const cached = cache.get(id);
      if (!force && cached && now() - cached.checkedAt < PROBE_TTL_MS) {
        return cached.result;
      }
      let result;
      try {
        const response = await request({
          provider: id,
          input: PROBE_INPUT,
        });
        result = {
          id,
          label,
          configured: true,
          working: true,
          model: typeof response?.model === "string" ? response.model : null,
          reason: null,
        };
      } catch (error) {
        result = { id, label, configured: true, working: false, ...describeFailure(error) };
      }
      cache.set(id, { checkedAt: now(), result });
      return result;
    }),
  );
}

export function formatAiProviderProbe(results, primaryProvider) {
  return results.map(({ id, label, working, configured, reason, model }) => {
    const mark = working ? "✅" : configured ? "❌" : "—";
    const detail = working ? `работи${model ? ` (${model})` : ""}` : reason;
    const primary = id === primaryProvider ? "; основен за разговора" : "";
    return `• ${mark} ${label} — ${detail}${primary}`;
  });
}
