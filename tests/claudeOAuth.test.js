import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import supertest from "supertest";
import { requireMcpAuthorization } from "../src/routes/mcpRouter.js";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CALLBACK,
  validateMcpAuthorizationRequest,
  createMcpAuthorizationCode,
  createMcpConsentToken,
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
    { scope: "synchron:google.read" },
    { scope: "synchron:google.write" },
    { scope: "synchron:memory.write" },
    { scope: "synchron:infrastructure.write" },
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

test("Claude allows only its named scopes to owners", async () => {
  const scope = "synchron:read synchron:agent.chat synchron:github.write synchron:audit.read offline_access";
  const request = await validateMcpAuthorizationRequest({ ...input, scope }, { env, fetchImpl: noFetch });
  assert.deepEqual(request.scopes, scope.split(" "));
  const member = { id: "member", memoryOwnerId: "member", role: "member" };
  assert.throws(() => createMcpConsentToken(request, member, env), { code: "access_denied" });
  assert.throws(() => createMcpAuthorizationCode(request, member, env), { code: "access_denied" });
  const readOnly = await validateMcpAuthorizationRequest(input, { env, fetchImpl: noFetch });
  assert.throws(() => createMcpAuthorizationCode(readOnly, member, env), { code: "access_denied" });
  await assert.rejects(validateMcpAuthorizationRequest({ ...input, scope: `${scope} synchron:google.write` }, { env, fetchImpl: noFetch }), { code: "invalid_scope" });
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

test("Claude tool calls cannot bypass owner confirmation or prepare forbidden cloud actions", async () => {
  resetMcpOAuthStateForTests();
  const request = await validateMcpAuthorizationRequest({
    ...input,
    scope: "synchron:read synchron:github.write",
  }, { env, fetchImpl: noFetch });
  const code = createMcpAuthorizationCode(request, {
    id: "owner", memoryOwnerId: "owner", role: "owner",
  }, env);
  const token = await exchangeMcpAuthorizationCode({
    grant_type: "authorization_code", code, client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, resource: env.MCP_RESOURCE_URL,
  }, env);
  const app = express();
  app.use(express.json());
  app.post("/mcp", (req, res, next) => requireMcpAuthorization(req, res, next, { env }), (_req, res) => res.json({ ok: true }));
  async function call(name, args = {}) {
    return supertest(app).post("/mcp").set("Authorization", `Bearer ${token.access_token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  }
  assert.equal((await call("get_github_file")).status, 200);
  assert.equal((await call("prepare_github_change", { operation: "update_file" })).status, 200);
  assert.equal((await call("prepare_google_cloud_action", { operation: "run_cloud_build_trigger" })).status, 403);
  assert.equal((await call("prepare_github_change", { operation: "merge_pr" })).status, 403);
  assert.equal((await call("confirm_github_change")).status, 403);
  assert.equal((await call("confirm_google_cloud_action")).status, 403);
  assert.equal((await call("get_personal_context")).status, 403);
});
