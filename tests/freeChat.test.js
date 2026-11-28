import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductPlansService,
  FREE_CHAT_DAILY_PER_PERSON,
  MEMORY_CHECK_DAILY_PER_PERSON,
} from "../src/services/productPlansService.js";
import {
  createPublicAiBudgetContext,
  markFreeChatTurn,
  reservePublicAiCall,
  reservePublicAiFile,
} from "../src/services/publicAiBudget.js";
import { isFreeChatTurnRequest } from "../src/routes/chat.js";

const member = { role: "member", memoryOwnerId: "identity-platform:free-one" };
const now = () => Date.UTC(2026, 10, 26, 12);
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
        const key = `${op.collection}/${op.id}`;
        const current = rows.get(key);
        if (op.createOnly && current) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
        if (op.updateTime && current?.updateTime !== op.updateTime) throw Object.assign(new Error("stale"), { code: "FAILED_PRECONDITION" });
      }
      for (const op of ops) rows.set(`${op.collection}/${op.id}`, { data: op.data, updateTime: `v${++version}` });
    },
  };
}

// Owner's decision 2026-11-26: talking with an economical model is free;
// Work mode, the Council, pictures and stronger models use units.
test("only a member's plain talk with an economical model is free", () => {
  const plain = { identity: member, mode: "chat", model: undefined, council: false, image: null };
  assert.equal(isFreeChatTurnRequest(plain), true);
  assert.equal(isFreeChatTurnRequest({ ...plain, model: "grok-3-mini" }), true);
  assert.equal(isFreeChatTurnRequest({ ...plain, model: "gemini-2.5-flash-lite" }), true);
  assert.equal(isFreeChatTurnRequest({ ...plain, model: "gemini-2.5-flash" }), false);
  assert.equal(isFreeChatTurnRequest({ ...plain, mode: "work" }), false);
  assert.equal(isFreeChatTurnRequest({ ...plain, council: true }), false);
  assert.equal(isFreeChatTurnRequest({ ...plain, image: "data:image/png;base64,AA" }), false);
  assert.equal(isFreeChatTurnRequest({ ...plain, identity: { role: "owner" } }), false);
});

test("free turns stop after 50 a day per person, then units are used", async () => {
  const service = createProductPlansService({ store: memoryStore(), now });
  for (let turn = 0; turn < FREE_CHAT_DAILY_PER_PERSON; turn++) {
    assert.equal(await service.useFreeChat(member), true);
  }
  assert.equal(await service.useFreeChat(member), false);
  assert.equal((await service.usage(member)).remaining, 100, "free turns took no units");
  const other = { role: "member", memoryOwnerId: "identity-platform:free-two" };
  assert.equal(await service.useFreeChat(other), true);
});

test("the shared daily ceiling also ends free turns", async () => {
  const service = createProductPlansService({ store: memoryStore(), now, env: { FREE_CHAT_DAILY_TOTAL: "2" } });
  assert.equal(await service.useFreeChat(member), true);
  assert.equal(await service.useFreeChat({ role: "member", memoryOwnerId: "x:2" }), true);
  assert.equal(await service.useFreeChat({ role: "member", memoryOwnerId: "x:3" }), false);
});

test("a free turn charges no units for text, but still does for a file", async () => {
  let charged = 0;
  const middleware = createPublicAiBudgetContext({ reserve: async (_identity, credits) => { charged += credits; } });
  await middleware({ owner: member }, {}, async () => {
    markFreeChatTurn();
    await reservePublicAiCall([{ role: "user", content: "Здравей" }], "claude", "claude-haiku-5-5");
    await reservePublicAiCall([{ role: "user", content: "Още" }], "openai", "planner");
    assert.equal(charged, 0);
    await reservePublicAiFile("claude", "claude-haiku-5-5");
    assert.equal(charged, 2);
  });
  await middleware({ owner: member }, {}, async () => {
    await reservePublicAiCall([{ role: "user", content: "Работа" }], "claude", "claude-haiku-5-5");
  });
  assert.equal(charged, 3, "a turn not marked free pays as before");
});

// The site's own check of a „Запомни: …“ costs a person nothing, so it has a
// daily count of its own; past it the one-time confirmation stays.
test("memory checks have their own daily count, apart from free turns and units", async () => {
  const service = createProductPlansService({ store: memoryStore(), now });
  for (let check = 0; check < MEMORY_CHECK_DAILY_PER_PERSON; check++) {
    assert.equal(await service.useMemoryCheck(member), true);
  }
  assert.equal(await service.useMemoryCheck(member), false);
  assert.equal(await service.useFreeChat(member), true, "free turns are counted apart");
  assert.equal((await service.usage(member)).remaining, 100, "checks took no units");
  assert.equal(await service.useMemoryCheck({ role: "member", memoryOwnerId: "identity-platform:check-two" }), true);
  assert.equal(await service.useMemoryCheck({ role: "owner" }), true);
  const tomorrow = createProductPlansService({ store: memoryStore(), now: () => now() + 86400000 });
  assert.equal(await tomorrow.useMemoryCheck(member), true);
});

test("the shared daily ceiling also ends memory checks", async () => {
  const service = createProductPlansService({ store: memoryStore(), now, env: { MEMORY_CHECK_DAILY_TOTAL: "2" } });
  assert.equal(await service.useMemoryCheck(member), true);
  assert.equal(await service.useMemoryCheck({ role: "member", memoryOwnerId: "x:2" }), true);
  assert.equal(await service.useMemoryCheck({ role: "member", memoryOwnerId: "x:3" }), false);
  await assert.rejects(() => service.useMemoryCheck({ role: "member" }), (error) => error.code === "AUTH_REQUIRED");
});
