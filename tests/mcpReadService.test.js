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

test("MCP exposes read tools and a two-step cleanup flow", () => {
  assert.deepEqual(
    MCP_TOOLS.map((tool) => tool.name),
    [
      "get_personal_context",
      "get_project_context",
      "list_synchron_conversations",
      "get_synchron_conversation",
      "get_digitalocean_app_status",
      "get_digitalocean_account_audit",
      "get_cloudflare_zone_status",
      "prepare_github_merged_branch_cleanup",
      "confirm_github_merged_branch_cleanup",
    ],
  );
  const confirm = MCP_TOOLS.find(
    (tool) => tool.name === "confirm_github_merged_branch_cleanup",
  );
  assert.equal(confirm.annotations.readOnlyHint, false);
  assert.equal(confirm.annotations.destructiveHint, true);
  assert.deepEqual(confirm.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:github.write"] },
  ]);
  const digitalOceanAudit = MCP_TOOLS.find(
    (tool) => tool.name === "get_digitalocean_account_audit",
  );
  assert.equal(digitalOceanAudit.annotations.readOnlyHint, true);
  assert.equal(digitalOceanAudit.annotations.destructiveHint, false);
  assert.deepEqual(digitalOceanAudit.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
});

test("MCP describes the confirmed destructive boundary honestly", async () => {
  const handle = createMcpRequestHandler();
  const response = await handle(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    "primary-user",
  );

  assert.match(response.result.instructions, /Повечето инструменти/u);
  assert.match(response.result.instructions, /destructive инструмент/u);
  assert.doesNotMatch(response.result.instructions, /мост е само за четене/u);
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
  assert.equal(
    response.result.structuredContent.items[0].fact,
    "Живея във Варна",
  );
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

test("MCP cleanup requires the exact one-time confirmation", async () => {
  const consumed = [];
  const handle = createMcpRequestHandler({
    buildCleanupPlan: async () => ({
      repository: "radostinvgeorgiev-commits/sunchron-backend",
      defaultBranch: "main",
      branchNames: ["merged-safe"],
      count: 1,
      fingerprint: "fingerprint",
    }),
    createConfirmation: async (data) => ({
      ...data,
      id: "confirmation-1",
      expiresAt: Date.now() + 60_000,
    }),
    validateConfirmation: async (id, ownerId) => ({
      id,
      sessionId: ownerId,
      action: "github.write:delete_merged_branches",
      resource: {
        repository: "radostinvgeorgiev-commits/sunchron-backend",
        fingerprint: "fingerprint",
      },
      params: { branchNames: ["merged-safe"] },
    }),
    consumeConfirmation: async (id) => consumed.push(id),
    executeCleanup: async ({ branchNames }) => ({
      deleted: branchNames,
      count: branchNames.length,
    }),
    audit: async () => {},
  });
  const prepared = await handle(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "prepare_github_merged_branch_cleanup",
        arguments: {},
      },
    },
    "primary-user",
  );
  assert.equal(
    prepared.result.structuredContent.confirmationId,
    "confirmation-1",
  );

  const confirmed = await handle(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "confirm_github_merged_branch_cleanup",
        arguments: { confirmationId: "confirmation-1" },
      },
    },
    "primary-user",
  );
  assert.equal(confirmed.result.structuredContent.count, 1);
  assert.deepEqual(consumed, ["confirmation-1"]);
});
