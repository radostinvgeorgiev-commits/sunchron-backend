import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_TOOLS,
  createMcpRequestHandler,
  isValidMcpToken,
} from "../src/services/mcpReadService.js";
import { CloudflareError } from "../src/services/cloudflareService.js";

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
      "talk_to_ai_core",
      "get_digitalocean_app_status",
      "get_system_configuration",
      "get_digitalocean_account_audit",
      "prepare_digitalocean_www_domain",
      "confirm_digitalocean_www_domain",
      "get_cloudflare_zone_status",
      "get_github_copilot_task_status",
      "prepare_github_merged_branch_cleanup",
      "confirm_github_merged_branch_cleanup",
      "send_message",
      "read_reply",
      "list_threads",
      "read_history",
      "continue_session",
      "propose_memory_change",
      "prepare_memory_write",
      "confirm_memory_write",
      "prepare_memory_delete",
      "confirm_memory_delete",
      "list_available_capabilities",
      "list_action_history",
      "list_recent_errors",
      "list_tasks",
      "create_task_draft",
      "add_task_note",
      "link_task_to_project",
      "prepare_task_status_change",
      "confirm_task_status_change",
      "list_projects",
      "get_github_overview",
      "get_github_file",
      "prepare_github_change",
      "confirm_github_change",
      "list_google_drive_files",
      "search_gmail",
      "create_gmail_draft",
      "prepare_gmail_send",
      "prepare_gmail_delete",
      "confirm_google_action",
      "list_google_calendar_events",
      "suggest_calendar_slots",
      "prepare_calendar_event",
      "confirm_calendar_event",
      "search_google_contacts",
      "prepare_google_contact",
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
  const conversation = MCP_TOOLS.find(
    (tool) => tool.name === "talk_to_ai_core",
  );
  assert.equal(conversation.annotations.readOnlyHint, false);
  assert.equal(conversation.annotations.destructiveHint, false);
  assert.equal(conversation.annotations.openWorldHint, true);
  assert.deepEqual(conversation.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:agent.chat"] },
  ]);
  const confirmWww = MCP_TOOLS.find(
    (tool) => tool.name === "confirm_digitalocean_www_domain",
  );
  assert.equal(confirmWww.annotations.readOnlyHint, false);
  assert.equal(confirmWww.annotations.destructiveHint, true);
  assert.deepEqual(confirmWww.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:infrastructure.write"] },
  ]);
  const digitalOceanAudit = MCP_TOOLS.find(
    (tool) => tool.name === "get_digitalocean_account_audit",
  );
  assert.equal(digitalOceanAudit.annotations.readOnlyHint, true);
  assert.equal(digitalOceanAudit.annotations.destructiveHint, false);
  assert.deepEqual(digitalOceanAudit.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
  const systemConfiguration = MCP_TOOLS.find(
    (tool) => tool.name === "get_system_configuration",
  );
  assert.equal(systemConfiguration.annotations.readOnlyHint, true);
  assert.deepEqual(systemConfiguration.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
  const publicStatus = MCP_TOOLS.find(
    (tool) => tool.name === "get_digitalocean_app_status",
  );
  assert.deepEqual(publicStatus.securitySchemes, [
    { type: "noauth" },
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
  const sendMessage = MCP_TOOLS.find((tool) => tool.name === "send_message");
  assert.equal(sendMessage.annotations.destructiveHint, false);
  assert.deepEqual(sendMessage.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:agent.chat"] },
  ]);
  const memoryWrite = MCP_TOOLS.find(
    (tool) => tool.name === "confirm_memory_write",
  );
  assert.equal(memoryWrite.annotations.destructiveHint, true);
  assert.deepEqual(memoryWrite.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:memory.write"] },
  ]);
  const googleWrite = MCP_TOOLS.find(
    (tool) => tool.name === "confirm_google_action",
  );
  assert.deepEqual(googleWrite.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:google.write"] },
  ]);
});

test("anonymous production status omits identifiers and configuration names", async () => {
  const handle = createMcpRequestHandler({
    getDigitalOceanStatus: async () => ({
      id: "private-app-id",
      name: "SYNCHRON-X",
      liveUrl: "https://synchron.foundation",
      activeDeployment: {
        id: "private-deployment-id",
        phase: "ACTIVE",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:01:00.000Z",
      },
      inProgressDeployment: null,
      environmentVariables: [{ key: "PRIVATE_VARIABLE_NAME" }],
      deploymentsAvailable: true,
      deployments: [
        {
          id: "private-history-id",
          phase: "ACTIVE",
          cause: "private commit message",
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:01:00.000Z",
        },
      ],
    }),
    getOAuthRuntimeStatus: () => ({
      authorization: "redirected",
      authorizationDecision: "allow",
      authorizationErrorCode: null,
      tokenExchange: "failed",
      grantType: "authorization_code",
      errorCode: "temporarily_unavailable",
      updatedAt: "2026-08-03T07:48:00.000Z",
    }),
    audit: async () => {},
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "get_digitalocean_app_status", arguments: {} },
    },
    null,
    { role: "anonymous" },
  );
  assert.equal(response.result.structuredContent.name, "SYNCHRON-X");
  assert.equal(response.result.structuredContent.id, undefined);
  assert.equal(
    response.result.structuredContent.activeDeployment.id,
    undefined,
  );
  assert.equal(
    response.result.structuredContent.environmentVariables,
    undefined,
  );
  assert.equal(
    response.result.structuredContent.deployments[0].cause,
    undefined,
  );
  assert.deepEqual(response.result.structuredContent.oauth, {
    authorization: "redirected",
    authorizationDecision: "allow",
    authorizationErrorCode: null,
    tokenExchange: "failed",
    grantType: "authorization_code",
    errorCode: "temporarily_unavailable",
    updatedAt: "2026-08-03T07:48:00.000Z",
  });
});

test("MCP sends one owner-scoped message to AI CORE and audits it", async () => {
  const events = [];
  const handle = createMcpRequestHandler({
    runAgentConversation: async (input) => {
      assert.equal(input.ownerId, "primary-user");
      assert.equal(input.message, "Дай една следваща стъпка");
      assert.equal(input.sessionId, "bridge-session");
      assert.equal(input.identity.role, "owner");
      return {
        sessionId: "bridge-session",
        response: "Провери разговора през MCP.",
        project: { id: "project-1", name: "SYNCHRON-X" },
        agent: { id: "agent-1", name: "AI CORE", role: "builder" },
        conversationPersisted: true,
        externalActionsExecuted: false,
        codeChanged: false,
      };
    },
    audit: async (event) => events.push(event),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "talk_to_ai_core",
        arguments: {
          message: "Дай една следваща стъпка",
          sessionId: "bridge-session",
        },
      },
    },
    "primary-user",
    { role: "owner", displayName: "Радко" },
  );
  assert.equal(response.result.content[0].text, "Провери разговора през MCP.");
  assert.equal(response.result.structuredContent.conversationPersisted, true);
  assert.equal(events[0].action, "agent.chat");
  assert.equal(events[0].actor, "chatgpt-mcp");
  assert.equal(events[0].outcome, "succeeded");
  assert.equal(events[0].details, "conversation-mcp");
});

test("MCP tracks a GitHub Copilot task as a read-only tool", async () => {
  const events = [];
  const handle = createMcpRequestHandler({
    getLatestGitHubSession: async () => ({
      login: "radostinvgeorgiev-commits",
      accessToken: "protected-token",
    }),
    getGitHubTaskStatus: async ({ githubSession, issueNumber }) => {
      assert.equal(githubSession.accessToken, "protected-token");
      assert.equal(issueNumber, 83);
      return {
        issue: {
          number: 83,
          title: "Проследи Copilot",
          url: "https://github.com/example/repo/issues/83",
        },
        pullRequest: null,
        checks: [],
        status: "copilot-working",
      };
    },
    audit: async (event) => events.push(event),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "get_github_copilot_task_status",
        arguments: { issueNumber: 83 },
      },
    },
    "primary-user",
  );
  assert.equal(response.result.structuredContent.status, "copilot-working");
  assert.equal(events[0].action, "github.read");
  const tool = MCP_TOOLS.find(
    (candidate) => candidate.name === "get_github_copilot_task_status",
  );
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.securitySchemes, [
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
});

test("MCP returns the safe system configuration without secret values", async () => {
  const events = [];
  const handle = createMcpRequestHandler({
    getSystemConfiguration: async () => ({
      status: "ready",
      secretsExposed: false,
      summary: {
        configured: 1,
        defaulted: 0,
        missingRequired: 0,
      },
      environment: [
        {
          key: "OPENAI_API_KEY",
          purpose: "AI ядро",
          status: "configured",
        },
      ],
      digitalOcean: { connected: true },
    }),
    audit: async (event) => events.push(event),
  });
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_system_configuration", arguments: {} },
    },
    "primary-user",
  );
  assert.equal(response.result.structuredContent.secretsExposed, false);
  assert.equal(
    response.result.structuredContent.environment[0].key,
    "OPENAI_API_KEY",
  );
  assert.equal(events[0].action, "infrastructure.read");
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

test("MCP www activation requires the exact one-time confirmation", async () => {
  const consumed = [];
  const writes = [];
  const handle = createMcpRequestHandler({
    inspectDigitalOceanDomain: async ({ domain }) => ({
      appId: "app-1",
      domain,
      configured: false,
      readAccessVerified: true,
      requiredWriteScope: "app:update",
    }),
    createConfirmation: async (data) => ({
      ...data,
      id: "www-confirmation-1",
      expiresAt: Date.now() + 60_000,
    }),
    validateConfirmation: async (id, ownerId) => ({
      id,
      sessionId: ownerId,
      action: "infrastructure.digitalocean:add_www_domain",
      resource: {
        appId: "app-1",
        domain: "www.synchron.foundation",
      },
      params: { domain: "www.synchron.foundation" },
    }),
    consumeConfirmation: async (id) => consumed.push(id),
    executeWrite: async (input) => {
      writes.push(input);
      return input.execute();
    },
    activateDigitalOceanDomain: async (input) => ({
      updated: true,
      appId: input.expectedAppId,
      domain: input.domain,
      deploymentId: "deployment-1",
    }),
    audit: async () => {},
  });

  const prepared = await handle(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "prepare_digitalocean_www_domain", arguments: {} },
    },
    "primary-user",
  );
  assert.equal(
    prepared.result.structuredContent.confirmationId,
    "www-confirmation-1",
  );

  const confirmed = await handle(
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "confirm_digitalocean_www_domain",
        arguments: { confirmationId: "www-confirmation-1" },
      },
    },
    "primary-user",
  );
  assert.equal(confirmed.result.structuredContent.updated, true);
  assert.equal(confirmed.result.structuredContent.deploymentId, "deployment-1");
  assert.deepEqual(consumed, ["www-confirmation-1"]);
  assert.equal(writes[0].action, "infrastructure.digitalocean:add_www_domain");
  assert.equal(writes[0].capability, "infrastructure.write");
  assert.equal(writes[0].confirmationId, "www-confirmation-1");
});

test("MCP exposes only controlled capability errors with a safe diagnostic code", async () => {
  const handler = createMcpRequestHandler({ audit: async () => {} });
  const response = await handler(
    {
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: {
        name: "search_gmail",
        arguments: { query: "from:client@example.com" },
      },
    },
    "primary-user",
    { role: "owner" },
  );

  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, "NOT_CONNECTED");
  assert.match(response.error.message, /Google не е свързан/u);
  assert.doesNotMatch(JSON.stringify(response), /token|password|secret/iu);
});

test("MCP exposes Cloudflare service errors with a safe diagnostic code", async () => {
  const handler = createMcpRequestHandler({
    getCloudflareStatus: async () => {
      throw new CloudflareError(
        "Cloudflare API върна грешка 403.",
        401,
        "CLOUDFLARE_UPSTREAM_ERROR",
      );
    },
    audit: async () => {},
  });
  const response = await handler(
    {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "get_cloudflare_zone_status", arguments: {} },
    },
    "primary-user",
    { role: "owner" },
  );

  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, "CLOUDFLARE_UPSTREAM_ERROR");
  assert.equal(response.error.message, "Cloudflare API върна грешка 403.");
  assert.doesNotMatch(JSON.stringify(response), /token|password|secret/iu);
});
