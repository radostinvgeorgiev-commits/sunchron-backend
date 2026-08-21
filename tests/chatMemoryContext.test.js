import assert from "node:assert/strict";
import test from "node:test";

import { loadChatMemoryContext } from "../src/routes/chat.js";

test("explicit memory actions do not depend on conversation history reads", async () => {
  const calls = [];

  const context = await loadChatMemoryContext({
    explicitMemoryIntent: true,
    sessionId: "memory-confirmation-session",
    ownerId: "owner-a",
    listMemories: async (options) => {
      calls.push(["memories", options]);
      return [{ id: "memory-1" }];
    },
    listMessages: async () => {
      throw new Error("conversation history must not be read");
    },
  });

  assert.deepEqual(context, {
    memories: [{ id: "memory-1" }],
    history: [],
  });
  assert.deepEqual(calls, [["memories", { ownerId: "owner-a" }]]);
});

test("normal chat still loads profile memory and conversation history", async () => {
  const calls = [];
  const context = await loadChatMemoryContext({
    explicitMemoryIntent: false,
    sessionId: "normal-chat-session",
    ownerId: "owner-a",
    listMemories: async (options) => {
      calls.push(["memories", options]);
      return [{ id: "memory-1" }];
    },
    listMessages: async (...args) => {
      calls.push(["messages", args]);
      return [{ id: "message-1" }];
    },
  });

  assert.deepEqual(context, {
    memories: [{ id: "memory-1" }],
    history: [{ id: "message-1" }],
  });
  assert.deepEqual(calls, [
    ["memories", { ownerId: "owner-a" }],
    ["messages", ["normal-chat-session", undefined, "owner-a"]],
  ]);
});

test("normal chat can load approved knowledge without changing legacy callers", async () => {
  const context = await loadChatMemoryContext({
    explicitMemoryIntent: false,
    sessionId: "knowledge-session",
    ownerId: "owner-a",
    listMemories: async () => [],
    listMessages: async () => [],
    listKnowledge: async () => [{ id: "knowledge-1", status: "approved" }],
  });

  assert.deepEqual(context.knowledge, [{ id: "knowledge-1", status: "approved" }]);
});
