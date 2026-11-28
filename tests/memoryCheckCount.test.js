import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
const { confirmPlainMemoryFacts } = await import("../src/services/memoryFactCheck.js");
const { createProductPlansService } = await import("../src/services/productPlansService.js");

function memoryStore() {
  const rows = new Map();
  let version = 0;
  return {
    async get(collection, id) {
      const row = rows.get(`${collection}/${id}`);
      return row ? structuredClone(row) : null;
    },
    async commitOperations(ops) {
      for (const op of ops) {
        const current = rows.get(`${op.collection}/${op.id}`);
        if (op.createOnly && current) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
        if (op.updateTime && current?.updateTime !== op.updateTime)
          throw Object.assign(new Error("stale"), { code: "FAILED_PRECONDITION" });
      }
      for (const op of ops) rows.set(`${op.collection}/${op.id}`, { data: op.data, updateTime: `v${++version}` });
    },
  };
}

const member = {
  id: "check-member",
  role: "member",
  authProvider: "identity-platform",
  memoryOwnerId: "identity-platform:check-member",
};

// The site's own check of a „Запомни: …“ costs a member nothing, so it has a
// daily count of its own (useMemoryCheck): past it, no model is asked and the
// one-time confirmation stays. Nothing is written without it.
test("past the daily count of checks, „Запомни: …“ asks no model and keeps the confirmation", async () => {
  const real = createProductPlansService({
    store: memoryStore(),
    env: { MEMORY_CHECK_DAILY_PER_PERSON: "2", MEMORY_CHECK_DAILY_TOTAL: "3000" },
  });
  let modelCalls = 0;
  const vertex = async () => {
    modelCalls += 1;
    return { text: '{"onlyFacts": true}' };
  };
  const replies = [];
  for (const fact of ["пия чай без захар", "обичам джаз", "живея във Варна", "работя като учител"]) {
    replies.push(await confirmPlainMemoryFacts({
      message: `Запомни: ${fact}`,
      facts: [fact],
      env: {
        VERTEX_AI_ENABLED: "true",
        VERTEX_AI_PROJECT_ID: "project-123",
        VERTEX_AI_MODEL: "gemini-2.5-flash",
      },
      vertex,
      allowCheck: () => real.useMemoryCheck(member),
    }));
  }
  assert.deepEqual(replies, [true, true, false, false]);
  assert.equal(modelCalls, 2, "only the counted checks reached a model");
  assert.equal((await real.usage(member)).remaining, 100, "the checks took no units");
});

// A failed count is no reason to write: the confirmation stays.
test("when the count fails, no model is asked and the confirmation stays", async () => {
  let modelCalls = 0;
  const result = await confirmPlainMemoryFacts({
    message: "Запомни: пия чай без захар",
    facts: ["пия чай без захар"],
    env: {
    VERTEX_AI_ENABLED: "true",
    VERTEX_AI_PROJECT_ID: "project-123",
    },
    vertex: async () => {
    modelCalls += 1;
    return { text: '{"onlyFacts": true}' };
    },
    allowCheck: async () => {
    throw new Error("Firestore недостъпен");
    },
  });
  assert.equal(result, false);
  assert.equal(modelCalls, 0);
});
