import assert from "node:assert/strict";
import test from "node:test";

import {
  isImportedConversationSessionId,
  saveImportedConversation,
  setFirestoreMemoryStoreForTests,
} from "../src/services/memoryService.js";
import {
  createMcpCapabilityHandler,
  MCP_CAPABILITY_TOOLS,
} from "../src/services/mcpCapabilityService.js";
import {
  MCP_AGENT_CHAT_SCOPE,
  requiredScopesForMcpTool,
} from "../src/services/mcpOAuthService.js";

function useFirestoreStore(t) {
  const keys = ["MEMORY_BACKEND", "PERSISTENCE_BACKEND"];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "firestore";
  const commits = [];
  setFirestoreMemoryStoreForTests({
    listProfileDocuments: async () => [],
    commitConversationDocuments: async (documents) => {
      commits.push(documents);
    },
  });
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    setFirestoreMemoryStoreForTests(null);
  });
  return commits;
}

const messages = [
  { role: "user", content: "Какво решихме за регистрацията?" },
  { role: "assistant", content: "Публична регистрация и 30 единици." },
];

test("a Claude conversation is saved as a new owner thread in order", async (t) => {
  const commits = useFirestoreStore(t);
  const saved = await saveImportedConversation(
    { source: "claude", messages },
    "owner-a",
    { now: () => Date.UTC(2026, 10, 24) },
  );
  assert.ok(isImportedConversationSessionId(saved.sessionId, "claude"));
  assert.equal(saved.saved, 2);
  assert.equal(saved.appended, false);
  const [documents] = commits;
  assert.deepEqual(
    documents.map(({ data }) => [data.ownerId, data.sessionId, data.role, data.source]),
    [
      ["owner-a", saved.sessionId, "user", "claude"],
      ["owner-a", saved.sessionId, "assistant", "claude"],
    ],
  );
  assert.ok(documents[0].data.createdAt < documents[1].data.createdAt);
});

test("an imported thread can be extended only from the same source", async (t) => {
  const commits = useFirestoreStore(t);
  const sessionId = "claude-12345678-1234-1234-1234-123456789abc";
  const saved = await saveImportedConversation(
    { source: "claude", sessionId, messages: messages.slice(0, 1) },
    "owner-a",
  );
  assert.equal(saved.sessionId, sessionId);
  assert.equal(saved.appended, true);
  for (const foreign of ["sess-f73bc947-5d0c-4653-aae5-947128617f3d", "chatgpt-12345678-1234-1234-1234-123456789abc"]) {
    await assert.rejects(
      saveImportedConversation({ source: "claude", sessionId: foreign, messages }, "owner-a"),
      { code: "CONVERSATION_IMPORT_INVALID" },
    );
  }
  assert.equal(commits.length, 1);
});

test("invalid conversation payloads are rejected before anything is written", async (t) => {
  const commits = useFirestoreStore(t);
  const invalid = [
    { messages: [] },
    { messages: Array.from({ length: 51 }, () => messages[0]) },
    { messages: [{ role: "system", content: "x" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "x".repeat(12001) }] },
    { source: "unknown", messages },
  ];
  for (const payload of invalid) {
    await assert.rejects(saveImportedConversation(payload, "owner-a"), {
      code: "CONVERSATION_IMPORT_INVALID",
    });
  }
  assert.equal(commits.length, 0);
});

test("save_conversation MCP tool uses the verified owner and the chat scope", async () => {
  const definition = MCP_CAPABILITY_TOOLS.find((item) => item.name === "save_conversation");
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(definition.annotations.destructiveHint, false);
  assert.deepEqual(requiredScopesForMcpTool("save_conversation"), [MCP_AGENT_CHAT_SCOPE]);

  const calls = [];
  const handler = createMcpCapabilityHandler({
    audit: async (event) => calls.push(["audit", event]),
    dependencies: {
      saveImportedConversation: async (input, ownerId) => {
        calls.push(["save", input, ownerId]);
        return { sessionId: "claude-x", source: input.source, saved: 2, appended: false };
      },
    },
  });
  const { handled, result } = await handler(
    "save_conversation",
    { messages, ownerId: "someone-else" },
    { ownerId: "verified-owner" },
  );
  assert.equal(handled, true);
  assert.equal(result.structuredContent.sessionId, "claude-x");
  const [, input, ownerId] = calls.find(([kind]) => kind === "save");
  assert.equal(ownerId, "verified-owner");
  assert.equal(input.source, "claude");
  const [, event] = calls.find(([kind]) => kind === "audit");
  assert.equal(event.action, "agent.chat");
  assert.equal(event.resource, "save_conversation");
});
