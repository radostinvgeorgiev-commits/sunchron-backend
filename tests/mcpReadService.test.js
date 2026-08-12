import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_TOOLS,
  createMcpRequestHandler,
  isValidMcpToken,
} from "../src/services/mcpReadService.js";

test("MCP token validation is fail-closed", () => {
  const token = "a".repeat(48);
  assert.equal(isValidMcpToken(`Bearer ${token}`, token), true);
  assert.equal(isValidMcpToken(`Bearer ${token}x`, token), false);
  assert.equal(isValidMcpToken("", token), false);
});

test("MCP exposes only current AI CORE, Google and GitHub tools", () => {
  const names = MCP_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("talk_to_ai_core"));
  assert.ok(names.includes("list_google_drive_files"));
  assert.ok(!names.some((name) => /digitalocean|cloudflare|supabase|opensearch/u.test(name)));
});

test("MCP handler returns protocol errors without legacy provider details", async () => {
  const handler = createMcpRequestHandler();
  const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "owner-id", { role: "owner" });
  assert.equal(response.result.tools.some((tool) => /digitalocean|cloudflare|supabase|opensearch/u.test(tool.name)), false);
});
