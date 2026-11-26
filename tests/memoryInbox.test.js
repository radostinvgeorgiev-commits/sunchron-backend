import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  approveMemorySuggestion,
  dismissMemorySuggestion,
  listMemorySuggestions,
  MAX_PENDING_SUGGESTIONS,
  setMemorySuggestionStoreForTests,
  suggestMemory,
} from "../src/services/memorySuggestionService.js";
import { createMemoryInboxRouter } from "../src/routes/memoryInboxRouter.js";
import {
  createMcpCapabilityHandler,
  MCP_CAPABILITY_TOOLS,
} from "../src/services/mcpCapabilityService.js";
import {
  MCP_AGENT_CHAT_SCOPE,
  requiredScopesForMcpTool,
} from "../src/services/mcpOAuthService.js";

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async queryEqual(collection, field, value) {
      return [...rows.entries()]
        .filter(([key, data]) => key.startsWith(`${collection}/`) && data[field] === value)
        .map(([key, data]) => ({ id: key.split("/").pop(), data: structuredClone(data) }));
    },
    async get(collection, id) {
      const data = rows.get(`${collection}/${id}`);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async set(collection, id, data) {
      rows.set(`${collection}/${id}`, structuredClone(data));
    },
    async delete(collection, id) {
      rows.delete(`${collection}/${id}`);
    },
  };
}

const allowWrites = { loadWorkspace: async () => ({ state: { preferences: {} } }) };

test("suggestions wait in the owner's inbox until approved", async (t) => {
  const store = memoryStore();
  setMemorySuggestionStoreForTests(store);
  t.after(() => setMemorySuggestionStoreForTests(null));
  let clock = Date.UTC(2026, 10, 25);
  const now = () => clock;

  const first = await suggestMemory(
    { ownerId: "owner-a", fact: "Предпочитам кратки отговори.", source: "claude" },
    { now },
  );
  clock += 1000;
  const duplicate = await suggestMemory(
    { ownerId: "owner-a", fact: "Предпочитам кратки отговори.", source: "claude" },
    { now },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  await suggestMemory({ ownerId: "owner-b", fact: "Чужд факт." }, { now });

  const inbox = await listMemorySuggestions("owner-a", { now });
  assert.deepEqual(inbox.map((item) => item.fact), ["Предпочитам кратки отговори"]);
  assert.equal(inbox[0].source, "claude");

  await assert.rejects(
    approveMemorySuggestion({ ownerId: "owner-b", id: first.id }, allowWrites),
    { code: "MEMORY_SUGGESTION_NOT_FOUND" },
  );

  const saved = [];
  const result = await approveMemorySuggestion(
    { ownerId: "owner-a", id: first.id, fact: "Предпочитам много кратки отговори." },
    { ...allowWrites, saveMemory: async (...args) => (saved.push(args), { id: "m1" }) },
  );
  assert.equal(result.approved, true);
  assert.deepEqual(saved[0], [
    "Предпочитам много кратки отговори.",
    "inbox-approved:claude",
    "personal",
    "owner-a",
  ]);
  assert.equal((await listMemorySuggestions("owner-a", { now })).length, 0);
});

test("dismissal, expiry, limits and the memory-off setting are enforced", async (t) => {
  const store = memoryStore();
  setMemorySuggestionStoreForTests(store);
  t.after(() => setMemorySuggestionStoreForTests(null));
  let clock = Date.UTC(2026, 10, 25);
  const now = () => clock;
  const item = await suggestMemory({ ownerId: "o", fact: "Факт едно." }, { now });
  await assert.rejects(
    approveMemorySuggestion(
      { ownerId: "o", id: item.id },
      { loadWorkspace: async () => ({ state: { preferences: { memoryMode: "disabled" } } }) },
    ),
    { code: "MEMORY_WRITE_DISABLED" },
  );
  assert.deepEqual(await dismissMemorySuggestion({ ownerId: "o", id: item.id }), { dismissed: true });
  await assert.rejects(dismissMemorySuggestion({ ownerId: "o", id: "not-an-id" }), {
    code: "MEMORY_SUGGESTION_INVALID",
  });

  await suggestMemory({ ownerId: "o", fact: "Стар факт." }, { now });
  clock += 31 * 86_400_000;
  assert.equal((await listMemorySuggestions("o", { now })).length, 0);

  for (let index = 0; index < MAX_PENDING_SUGGESTIONS; index += 1) {
    await suggestMemory({ ownerId: "full", fact: `Факт номер ${index}.` }, { now });
  }
  await assert.rejects(suggestMemory({ ownerId: "full", fact: "Още един." }, { now }), {
    code: "MEMORY_SUGGESTIONS_FULL",
  });
  await assert.rejects(suggestMemory({ ownerId: "o", fact: "" }, { now }), {
    code: "MEMORY_SUGGESTION_INVALID",
  });
});

test("inbox routes use the signed-in memory owner only", async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "owner-a" };
    next();
  });
  app.use(
    "/api/memory-inbox",
    createMemoryInboxRouter({
      list: async (ownerId) => (calls.push(["list", ownerId]), [{ id: "x", fact: "f" }]),
      approve: async (input) => (calls.push(["approve", input]), { approved: true }),
      dismiss: async (input) => (calls.push(["dismiss", input]), { dismissed: true }),
    }),
  );
  const listed = await request(app).get("/api/memory-inbox").expect(200);
  assert.equal(listed.headers["cache-control"], "no-store");
  await request(app)
    .post("/api/memory-inbox/abc/approve")
    .send({ fact: "нов", ownerId: "evil" })
    .expect(200);
  await request(app).post("/api/memory-inbox/abc/dismiss").expect(200);
  assert.deepEqual(calls, [
    ["list", "owner-a"],
    ["approve", { ownerId: "owner-a", id: "abc", fact: "нов" }],
    ["dismiss", { ownerId: "owner-a", id: "abc" }],
  ]);
});

test("suggest_memory MCP tool only suggests, for the verified owner", async () => {
  const definition = MCP_CAPABILITY_TOOLS.find((item) => item.name === "suggest_memory");
  assert.ok(definition);
  assert.equal(definition.annotations.destructiveHint, false);
  assert.deepEqual(requiredScopesForMcpTool("suggest_memory"), [MCP_AGENT_CHAT_SCOPE]);
  const calls = [];
  const handler = createMcpCapabilityHandler({
    audit: async (event) => calls.push(["audit", event]),
    dependencies: {
      suggestMemory: async (input) => (calls.push(["suggest", input]), { id: "s1", fact: input.fact }),
    },
  });
  const { result } = await handler(
    "suggest_memory",
    { fact: "Работя от София." },
    { ownerId: "verified-owner" },
  );
  assert.match(result.content[0].text, /Входящи/u);
  assert.deepEqual(calls[0], [
    "suggest",
    { ownerId: "verified-owner", fact: "Работя от София.", scope: "personal", source: "claude" },
  ]);
});
