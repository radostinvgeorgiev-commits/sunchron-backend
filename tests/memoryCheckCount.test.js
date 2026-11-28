import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.AI_CORE_PROVIDER = "openai";
// Test values only: every model call below is a stub.
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GEMINI_API_KEY = "test-gemini-key";

const { default: chatRouter } = await import("../src/routes/chat.js");
const { publicAiBudgetContext } = await import("../src/services/publicAiBudget.js");
const { createProductPlansService, getProductPlansService } = await import(
  "../src/services/productPlansService.js"
);
const { resetLocalDocumentStoreForTests } = await import("../src/services/localDocumentStore.js");
const { resetConfirmationsForTests } = await import("../src/services/confirmationService.js");
const { listProfileMemories } = await import("../src/services/memoryService.js");

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

function memberApp() {
  const app = express();
  app.use(express.json());
  // The budget middleware as server.js mounts it.
  app.use(
    "/chat",
    (req, _res, next) => {
      req.owner = member;
      next();
    },
    publicAiBudgetContext,
    chatRouter,
  );
  return app;
}

// The site's own check of a „Запомни: …“ costs a member nothing, so it has a
// daily count of its own (useMemoryCheck): past it, no model is asked and the
// one-time confirmation stays. Nothing is written without it.
test("past the daily count of checks, „Запомни: …“ asks no model and keeps the confirmation", async (t) => {
  resetConfirmationsForTests();
  resetLocalDocumentStoreForTests();
  const real = createProductPlansService({
    store: memoryStore(),
    env: { MEMORY_CHECK_DAILY_PER_PERSON: "2", MEMORY_CHECK_DAILY_TOTAL: "3000" },
  });
  const plans = getProductPlansService();
  for (const name of ["useFreeChat", "useMemoryCheck", "usage", "reserve", "refund"]) {
    t.mock.method(plans, name, (...args) => real[name](...args));
  }
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    modelCalls += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"onlyFacts": true}' }] } }] });
  });
  const app = memberApp();
  const replies = [];
  for (const fact of ["пия чай без захар", "обичам джаз", "живея във Варна", "работя като учител"]) {
    const response = await request(app)
      .post("/chat/chat")
      .send({ sessionId: "check-count", message: `Запомни: ${fact}` })
      .expect(200);
    replies.push(
      /Запомних:/u.test(response.text)
        ? "written"
        : /Потвърждавам постоянен запис/u.test(response.text)
          ? "confirmation"
          : "other",
    );
  }
  assert.deepEqual(replies, ["written", "written", "confirmation", "confirmation"]);
  assert.equal(modelCalls, 2, "only the counted checks reached a model");
  const saved = await listProfileMemories({ scope: "personal", ownerId: member.memoryOwnerId });
  assert.deepEqual(saved.map(({ fact }) => fact).sort(), ["обичам джаз", "пия чай без захар"]);
  assert.equal((await real.usage(member)).remaining, 100, "the checks took no units");
});

// A failed count is no reason to write: the confirmation stays.
test("when the count fails, no model is asked and the confirmation stays", async (t) => {
  resetConfirmationsForTests();
  resetLocalDocumentStoreForTests();
  const plans = getProductPlansService();
  t.mock.method(plans, "useFreeChat", async () => true);
  t.mock.method(plans, "useMemoryCheck", async () => {
    throw new Error("Firestore недостъпен");
  });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    modelCalls += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"onlyFacts": true}' }] } }] });
  });
  const response = await request(memberApp())
    .post("/chat/chat")
    .send({ sessionId: "check-count-down", message: "Запомни: пия чай без захар" })
    .expect(200);
  assert.match(response.text, /Потвърждавам постоянен запис/u);
  assert.equal(modelCalls, 0);
  assert.deepEqual(await listProfileMemories({ scope: "personal", ownerId: member.memoryOwnerId }), []);
});
