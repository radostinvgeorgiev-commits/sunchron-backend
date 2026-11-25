import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiSpendService,
  estimateCostUsd,
  priceForModel,
} from "../src/services/aiSpendService.js";
import { createAiSpendRouter } from "../src/routes/aiSpendRouter.js";

function memoryStore() {
  const docs = new Map();
  let version = 0;
  const key = (c, id) => `${c}/${id}`;
  return {
    docs,
    async get(c, id, options = {}) {
      const row = docs.get(key(c, id));
      if (!row) return null;
      return options.includeMetadata ? { data: row.data, updateTime: row.updateTime } : row.data;
    },
    async set(c, id, data) {
      docs.set(key(c, id), { data, updateTime: String(++version) });
    },
    async commitOperations(operations) {
      for (const op of operations) {
        const current = docs.get(key(op.collection, op.id));
        if (op.createOnly && current) throw new Error("exists");
        if (op.updateTime && current?.updateTime !== op.updateTime) throw new Error("conflict");
        docs.set(key(op.collection, op.id), { data: op.data, updateTime: String(++version) });
      }
    },
  };
}

test("prices resolve by model prefix and unknown models stay unpriced", () => {
  assert.deepEqual(priceForModel("claude-haiku-5-5-20261007"), [0.1, 0.5]);
  assert.deepEqual(priceForModel("models/gemini-3.5-flash-lite"), [0.3, 2.5]);
  assert.equal(priceForModel("mystery-model"), null);
  assert.equal(
    estimateCostUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    0.6,
  );
});

test("concurrent calls are all counted and the ring percent uses the limit", async () => {
  const store = memoryStore();
  const service = createAiSpendService({ store, now: () => Date.UTC(2026, 10, 25) });
  await Promise.all([
    service.record({ provider: "claude", model: "claude-haiku-5-5", inputTokens: 1_000_000, outputTokens: 0 }),
    service.record({ provider: "claude", model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 1_000_000 }),
    service.record({ provider: "x", model: "mystery", inputTokens: 10, outputTokens: 10 }),
  ]);
  await service.setLimit(2);
  const summary = await service.summary();
  assert.equal(summary.month, "2026-11");
  assert.equal(summary.totalUsd, 0.6);
  assert.equal(summary.limitUsd, 2);
  assert.equal(summary.percent, 30);
  const haiku = summary.models.find((m) => m.model === "claude-haiku-5-5");
  assert.equal(haiku.calls, 2);
  assert.equal(summary.models.find((m) => m.model === "mystery").priced, false);
});

test("an invalid limit is refused", async () => {
  const service = createAiSpendService({ store: memoryStore() });
  await assert.rejects(service.setLimit(-1), { code: "AI_SPEND_INVALID_LIMIT" });
  await assert.rejects(service.setLimit("abc"), { code: "AI_SPEND_INVALID_LIMIT" });
});

test("router returns the summary and reports a bad limit as 400", async () => {
  const router = createAiSpendRouter({
    service: {
      summary: async () => ({ totalUsd: 1 }),
      setLimit: async () => {
        throw Object.assign(new Error("bad"), { status: 400, code: "AI_SPEND_INVALID_LIMIT" });
      },
    },
  });
  const layer = (method, path) =>
    router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => ((r.statusCode = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  const a = res();
  await layer("get", "/")({}, a);
  assert.deepEqual(a.body, { totalUsd: 1 });
  const b = res();
  await layer("put", "/limit")({ body: { limitUsd: -1 } }, b);
  assert.equal(b.statusCode, 400);
});
