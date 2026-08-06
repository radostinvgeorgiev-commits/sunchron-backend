import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpCapabilityHandler,
  MCP_CAPABILITY_TOOLS,
} from "../src/services/mcpCapabilityService.js";
import {
  MCP_AGENT_CHAT_SCOPE,
  MCP_GOOGLE_WRITE_SCOPE,
  MCP_MEMORY_WRITE_SCOPE,
} from "../src/services/mcpOAuthService.js";

test("granular MCP capabilities have unique names, strict schemas and exact scopes", () => {
  const names = MCP_CAPABILITY_TOOLS.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("send_message"));
  assert.ok(names.includes("read_reply"));
  assert.ok(names.includes("confirm_github_change"));
  assert.ok(names.includes("confirm_google_action"));
  assert.ok(names.includes("confirm_task_status_change"));
  assert.ok(
    MCP_CAPABILITY_TOOLS.every(
      (item) =>
        item.inputSchema?.type === "object" &&
        item.inputSchema.additionalProperties === false &&
        Array.isArray(item.securitySchemes) &&
        item.securitySchemes.length >= 1,
    ),
  );
  const scopeFor = (name) =>
    MCP_CAPABILITY_TOOLS.find((item) => item.name === name).securitySchemes[0]
      .scopes;
  assert.deepEqual(scopeFor("send_message"), [MCP_AGENT_CHAT_SCOPE]);
  assert.deepEqual(scopeFor("prepare_memory_write"), [MCP_MEMORY_WRITE_SCOPE]);
  assert.deepEqual(scopeFor("confirm_google_action"), [MCP_GOOGLE_WRITE_SCOPE]);
  assert.equal(
    MCP_CAPABILITY_TOOLS.find((item) => item.name === "confirm_google_action")
      .annotations.destructiveHint,
    true,
  );
});

test("send_message injects the verified owner and preserves the safe chat boundary", async () => {
  const calls = [];
  const handler = createMcpCapabilityHandler({
    audit: async (event) => calls.push(["audit", event]),
    dependencies: {
      sendAgentMessage: async (input) => {
        calls.push(["send", input]);
        return {
          sessionId: "mcp-thread-1",
          response: "Проверен отговор",
          externalActionsExecuted: false,
        };
      },
    },
  });
  const call = await handler(
    "send_message",
    { message: "Провери паметта", projectId: "project-1" },
    {
      ownerId: "verified-owner",
      identity: { role: "owner", displayName: "Радко" },
    },
  );

  assert.equal(call.handled, true);
  assert.equal(call.result.structuredContent.sessionId, "mcp-thread-1");
  assert.equal(calls[0][1].ownerId, "verified-owner");
  assert.equal(calls[0][1].sessionId, undefined);
  assert.equal(calls[1][1].action, "agent.chat");
});

test("task drafts and memory updates cannot substitute the verified owner", async () => {
  const calls = [];
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    dependencies: {
      createTaskDraft: async (input) => {
        calls.push(["task", input]);
        return { id: "task-1", title: input.title, status: "draft" };
      },
      prepareMemoryWrite: async (input) => {
        calls.push(["memory", input]);
        return {
          confirmationId: "confirmation-1",
          expiresAt: Date.now() + 60_000,
          items: input.items,
        };
      },
    },
  });

  await handler(
    "create_task_draft",
    { title: "Задача", ownerId: "attacker" },
    { ownerId: "verified-owner" },
  );
  await handler(
    "prepare_memory_write",
    {
      fact: "Точен факт",
      scope: "project",
      memoryId: "memory-old",
      ownerId: "attacker",
    },
    { ownerId: "verified-owner" },
  );

  assert.equal(calls[0][1].ownerId, "verified-owner");
  assert.equal(calls[1][1].ownerId, "verified-owner");
  assert.equal(calls[1][1].replaceId, "memory-old");
  assert.equal(calls[1][1].sessionId, "verified-owner");
});

test("Google capabilities fail closed when no authorized owner session exists", async () => {
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    resolveLatestGoogleSession: async () => null,
  });
  await assert.rejects(
    () =>
      handler(
        "search_gmail",
        { query: "from:client@example.com" },
        { ownerId: "verified-owner" },
      ),
    (error) => error.code === "NOT_CONNECTED" && error.status === 401,
  );
});

test("unsupported names are left to the legacy MCP handler", async () => {
  const handler = createMcpCapabilityHandler({ audit: async () => {} });
  assert.deepEqual(
    await handler("legacy_tool", {}, { ownerId: "verified-owner" }),
    { handled: false, result: null },
  );
});
