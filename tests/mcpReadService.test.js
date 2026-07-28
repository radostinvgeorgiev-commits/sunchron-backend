import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_TOOLS,
  createMcpRequestHandler,
  isValidMcpToken,
} from "../src/services/mcpReadService.js";

test("MCP token validation is fail-closed and timing-safe compatible", () => {
  const token = "a".repeat(48);
  assert.equal(isValidMcpToken(`Bearer ${token}`, token), true);
  assert.equal(isValidMcpToken(`Bearer ${token}x`, token), false);
  assert.equal(isValidMcpToken("", token), false);
  assert.equal(isValidMcpToken(`Bearer ${token}`, "short"), false);
});

test("MCP exposes only four read-only tools", () => {
  assert.deepEqual(
    MCP_TOOLS.map((tool) => tool.name),
    [
      "get_personal_context",
      "get_project_context",
      "list_synchron_conversations",
      "get_synchron_conversation",
    ],
  );
  assert.ok(MCP_TOOLS.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(MCP_TOOLS.every((tool) => tool.annotations.destructiveHint === false));
});

test("MCP reads owner-scoped personal memory and audits the call", async () => {
  const calls = [];
  const handle = createMcpRequestHandler({
    listMemories: async (options) => {
      calls.push(["memory", options]);
      return [{ id: "1", fact: "Живея във Варна", scope: "personal" }];
    },
    audit: async (event) => calls.push(["audit", event]),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_personal_context", arguments: {} },
    },
    "primary-user",
  );
  assert.equal(response.result.structuredContent.items[0].fact, "Живея във Варна");
  assert.deepEqual(calls[0][1], {
    scope: "personal",
    ownerId: "primary-user",
  });
  assert.equal(calls[1][1].action, "memory.read");
  assert.equal(calls[1][1].actor, "chatgpt-mcp");
});

test("MCP rejects invalid conversation identifiers without reading", async () => {
  let reads = 0;
  const handle = createMcpRequestHandler({
    listMessages: async () => {
      reads += 1;
      return [];
    },
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "get_synchron_conversation",
        arguments: { sessionId: "" },
      },
    },
    "primary-user",
  );
  assert.equal(response.error.code, -32602);
  assert.equal(reads, 0);
});
