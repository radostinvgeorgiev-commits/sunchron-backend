import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CALLBACK,
  CLAUDE_SCOPES,
  requiredScopesForMcpTool,
  validateMcpAuthorizationRequest,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  verifyMcpAccessToken,
  resetMcpOAuthStateForTests,
} from "../src/services/mcpOAuthService.js";

const env = {
  MCP_ACCESS_TOKEN:
    "isolated-claude-oauth-test-secret-longer-than-32-characters",
  MCP_RESOURCE_URL: "https://cloudaicore.com/mcp",
  MCP_CLAUDE_OAUTH_ENABLED: "true",
};
const verifier = "c".repeat(64);
const input = {
  response_type: "code",
  client_id: CLAUDE_CLIENT_ID,
  redirect_uri: CLAUDE_CALLBACK,
  state: "claude-test-state",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  resource: env.MCP_RESOURCE_URL,
  scope: "synchron:read offline_access",
};
const noFetch = () => {
  throw new Error("No metadata fetch for registered Claude");
};

test("Claude is opt-in and fails closed for callbacks, scopes and PKCE", async () => {
  await assert.rejects(
    validateMcpAuthorizationRequest(input, {
      env: { ...env, MCP_CLAUDE_OAUTH_ENABLED: "false" },
      fetchImpl: noFetch,
    }),
  );
  for (const override of [
    { redirect_uri: "https://evil.example/api/mcp/auth_callback" },
    { redirect_uri: CLAUDE_CALLBACK + "?next=evil" },
    { client_id: "synchron-claude-evil" },
    { scope: "synchron:github.write" },
    { scope: "synchron:google.read" },
    { code_challenge_method: "plain" },
    { resource: "https://evil.example/mcp" },
  ])
    await assert.rejects(
      validateMcpAuthorizationRequest(
        { ...input, ...override },
        { env, fetchImpl: noFetch },
      ),
    );
});

test("Claude completes PKCE exchange and tokens cannot be used by another client", async () => {
  resetMcpOAuthStateForTests();
  const request = await validateMcpAuthorizationRequest(input, {
    env,
    fetchImpl: noFetch,
  });
  assert.equal(request.clientName, "Claude");
  const identity = {
    id: "claude-owner-test",
    memoryOwnerId: "claude-memory-test",
    role: "owner",
  };
  const code = createMcpAuthorizationCode(request, identity, env);
  const exchange = {
    grant_type: "authorization_code",
    code,
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: verifier,
    resource: env.MCP_RESOURCE_URL,
  };
  await assert.rejects(
    exchangeMcpAuthorizationCode(
      { ...exchange, client_id: "synchron-gemini-cli" },
      env,
    ),
  );
  const token = await exchangeMcpAuthorizationCode(exchange, env);
  const verified = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    ["synchron:read"],
    env,
  );
  assert.equal(verified.clientId, CLAUDE_CLIENT_ID);
  assert.equal(verified.memoryOwnerId, identity.memoryOwnerId);
  assert.throws(() =>
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      ["synchron:github.write"],
      env,
    ),
  );
  await assert.rejects(exchangeMcpAuthorizationCode(exchange, env));
});

test("one Claude sign-in grants the read and chat tools, never write scopes", async () => {
  resetMcpOAuthStateForTests();
  for (const scope of [
    "synchron:read",
    "synchron:agent.chat",
    "synchron:read offline_access",
    undefined,
  ]) {
    const request = await validateMcpAuthorizationRequest(
      { ...input, scope },
      { env, fetchImpl: noFetch },
    );
    assert.deepEqual(request.scopes, [...CLAUDE_SCOPES]);
  }
  for (const scope of [
    "synchron:memory.write",
    "synchron:tasks.write",
    "synchron:agent.chat synchron:infrastructure.write",
    "synchron:chatgpt.ask",
  ])
    await assert.rejects(
      validateMcpAuthorizationRequest(
        { ...input, scope },
        { env, fetchImpl: noFetch },
      ),
    );

  const request = await validateMcpAuthorizationRequest(
    { ...input, scope: "synchron:read" },
    { env, fetchImpl: noFetch },
  );
  const code = createMcpAuthorizationCode(
    request,
    { id: "claude-member", memoryOwnerId: "claude-member-memory", role: "member" },
    env,
  );
  const token = await exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      resource: env.MCP_RESOURCE_URL,
    },
    env,
  );
  assert.ok(token.refresh_token);
  for (const tool of ["save_conversation", "read_history", "get_project_context"])
    assert.ok(
      verifyMcpAccessToken(
        `Bearer ${token.access_token}`,
        requiredScopesForMcpTool(tool),
        env,
      ),
      tool,
    );
  assert.throws(() =>
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      requiredScopesForMcpTool("confirm_memory_write"),
      env,
    ),
  );
});
