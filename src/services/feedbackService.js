import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// 👍/👎 on answers and votes from blind comparisons, counted per model and
// month. Only counts are stored: no message text and no account id.
export const FEEDBACK_COLLECTION = "synchron-feedback-v1";
const KINDS = new Set(["up", "down", "win", "loss", "tie"]);

export class FeedbackError extends Error {
  constructor(message, status = 400, code = "FEEDBACK_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function modelKey(provider, model) {
  const key = `${String(provider || "").trim()}:${String(model || "").trim()}`
    .replace(/[^A-Za-z0-9:._-]/gu, "_")
    .slice(0, 100);
  if (key.length < 3) throw new FeedbackError("Липсва модел.");
  return key.replaceAll(".", "_");
}

export function createFeedbackService({ store, env = process.env, now = () => Date.now() } = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));
  let queue = Promise.resolve();

  async function write(entries) {
    const id = new Date(now()).toISOString().slice(0, 7);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await db().get(FEEDBACK_COLLECTION, id, { includeMetadata: true });
      const data = row?.data || { month: id, models: {} };
      const models = { ...data.models };
      for (const { key, kind } of entries) {
        models[key] = { up: 0, down: 0, win: 0, loss: 0, tie: 0, ...models[key] };
        models[key][kind] += 1;
      }
      try {
        await db().commitOperations([
          {
            type: "set",
            collection: FEEDBACK_COLLECTION,
            id,
            data: { ...data, models, updatedAt: now() },
            ...(row?.updateTime ? { updateTime: row.updateTime } : { createOnly: true }),
          },
        ]);
        return;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }

  function record(votes) {
    const entries = (Array.isArray(votes) ? votes : [votes]).slice(0, 2).map((vote) => {
      if (!KINDS.has(vote?.kind)) throw new FeedbackError("Невалидна оценка.");
      return { key: modelKey(vote.provider, vote.model), kind: vote.kind };
    });
    if (!entries.length) throw new FeedbackError("Липсва оценка.");
    const run = queue.then(() => write(entries));
    queue = run.catch(() => {});
    return run;
  }

  async function summary() {
    const id = new Date(now()).toISOString().slice(0, 7);
    const row = await db().get(FEEDBACK_COLLECTION, id);
    return {
      month: id,
      models: Object.entries(row?.data?.models || {}).map(([model, counts]) => ({ model, ...counts })),
    };
  }

  return { record, summary };
}
