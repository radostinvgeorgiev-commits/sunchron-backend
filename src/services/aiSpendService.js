import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// Estimated AI spend for the month, from the token counts each provider
// returns. Provider balances cannot be read with an ordinary API key, so this
// is an estimate from list prices, shown next to a limit Радко sets himself.

export const AI_SPEND_COLLECTION = "synchron-ai-spend-v1";
const SETTINGS_ID = "settings";
const DEFAULT_LIMIT_USD = 10;
const MAX_LIMIT_USD = 10_000;

// USD per 1M tokens [input, output], standard tier, checked 2026-11-25.
// Prefix match, longest first, so dated or versioned ids resolve too.
export const AI_MODEL_PRICES = Object.freeze({
  "claude-haiku-5-5": [0.1, 0.5],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-5.3-codex": [1.75, 14],
  "gemini-3.5-flash-lite": [0.3, 2.5],
  "gemini-3.8-flash": [0.75, 3.75],
  "grok-3-mini": [0.3, 0.5],
  // Vertex AI Model Garden list prices (checked 2026-11-26).
  "openai/gpt-oss-120b": [0.09, 0.36],
  "google/gemma-4-26b": [0.15, 0.6],
  "deepseek-ai/deepseek-v4.1-flash": [0.3, 1.2],
  "zai-org/glm-5.2": [1.4, 4.4],
});

export function priceForModel(model) {
  const id = String(model || "").toLowerCase().replace(/^models\//u, "");
  const match = Object.keys(AI_MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((key) => id.startsWith(key));
  return match ? AI_MODEL_PRICES[match] : null;
}

export function estimateCostUsd(model, { inputTokens = 0, outputTokens = 0 } = {}) {
  const price = priceForModel(model);
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

function monthId(now) {
  return new Date(now()).toISOString().slice(0, 7);
}

function modelKey(model) {
  return String(model || "unknown")
    .replace(/^models\//u, "")
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .slice(0, 80);
}

const round = (value) => Math.round(value * 1_000_000) / 1_000_000;

export function createAiSpendService({
  store,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  // Council fires several providers at once; writes from this instance go
  // one after another so they do not fight over the same month document.
  let queue = Promise.resolve();
  function record(usage) {
    const run = queue.then(() => writeRecord(usage));
    queue = run.catch(() => {});
    return run;
  }

  async function writeRecord({ provider, model, inputTokens = 0, outputTokens = 0 }) {
    const cost = estimateCostUsd(model, { inputTokens, outputTokens });
    const key = modelKey(model);
    const id = monthId(now);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await db().get(AI_SPEND_COLLECTION, id, { includeMetadata: true });
      const data = row?.data || { month: id, totalUsd: 0, models: {} };
      const entry = data.models?.[key] || {
        provider: String(provider || ""),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        priced: cost !== null,
      };
      const next = {
        ...data,
        totalUsd: round((Number(data.totalUsd) || 0) + (cost || 0)),
        models: {
          ...data.models,
          [key]: {
            ...entry,
            calls: entry.calls + 1,
            inputTokens: entry.inputTokens + inputTokens,
            outputTokens: entry.outputTokens + outputTokens,
            usd: round((Number(entry.usd) || 0) + (cost || 0)),
            priced: cost !== null,
          },
        },
        updatedAt: now(),
      };
      try {
        await db().commitOperations([
          {
            type: "set",
            collection: AI_SPEND_COLLECTION,
            id,
            data: next,
            ...(row?.updateTime ? { updateTime: row.updateTime } : { createOnly: true }),
          },
        ]);
        return;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }

  async function summary() {
    const id = monthId(now);
    const [month, settings] = await Promise.all([
      db().get(AI_SPEND_COLLECTION, id, { includeMetadata: true }),
      db().get(AI_SPEND_COLLECTION, SETTINGS_ID, { includeMetadata: true }),
    ]);
    const data = month?.data || {};
    const limitUsd = Number(settings?.data?.limitUsd) || DEFAULT_LIMIT_USD;
    const models = Object.entries(data.models || {})
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const totalUsd = Number(data.totalUsd) || 0;
    return {
      month: id,
      totalUsd: round(totalUsd),
      limitUsd,
      percent: Math.min(100, Math.round((totalUsd / limitUsd) * 1000) / 10),
      models,
      estimated: true,
    };
  }

  async function setLimit(value) {
    const limitUsd = Number(value);
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > MAX_LIMIT_USD) {
      const error = new Error("Лимитът трябва да е между $0.01 и $10 000.");
      error.status = 400;
      error.code = "AI_SPEND_INVALID_LIMIT";
      throw error;
    }
    await db().set(AI_SPEND_COLLECTION, SETTINGS_ID, {
      limitUsd: Math.round(limitUsd * 100) / 100,
      updatedAt: now(),
    });
    return summary();
  }

  return { record, summary, setLimit };
}

let defaultService = null;
export function getAiSpendService() {
  return (defaultService ||= createAiSpendService());
}
