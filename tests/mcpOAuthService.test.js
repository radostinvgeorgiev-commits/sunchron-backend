import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  cleanupExpiredMcpReplayRecords,
  consumeMcpGrantOnce,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  getMcpAuthorizationServerMetadata,
  getMcpProtectedResourceMetadata,
  MCP_GITHUB_WRITE_SCOPE,
  MCP_READ_SCOPE,
  requiresPersistentMcpReplayGuard,
  resetMcpOAuthStateForTests,
  validateMcpAuthorizationRequest,
  verifyMcpAccessToken,
} from "../src/services/mcpOAuthService.js";

const ENV = {
  MCP_ACCESS_TOKEN: "mcp-oauth-test-secret-with-more-than-32-characters",
  MCP_RESOURCE_URL: "https://synchron.foundation/mcp",
};
const CLIENT_ID = "https://chatgpt.com/oauth/synchron/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/test-callback";
const VERIFIER = "v".repeat(64);

function authorizationInput(scopes = [MCP_READ_SCOPE]) {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "state-123",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    resource: ENV.MCP_RESOURCE_URL,
    scope: scopes.join(" "),
  };
}

function clientMetadataFetch(url) {
  assert.equal(url, CLIENT_ID);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        client_id: CLIENT_ID,
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

test.beforeEach(() => resetMcpOAuthStateForTests());

test("publishes OAuth 2.1 protected-resource and authorization metadata", () => {
  assert.deepEqual(getMcpProtectedResourceMetadata(ENV), {
    resource: ENV.MCP_RESOURCE_URL,
    authorization_servers: ["https://synchron.foundation"],
    scopes_supported: [MCP_READ_SCOPE, MCP_GITHUB_WRITE_SCOPE],
  });
  const authorization = getMcpAuthorizationServerMetadata(ENV);
  assert.equal(
    authorization.authorization_endpoint,
    "https://synchron.foundation/oauth/authorize",
  );
  assert.equal(authorization.token_endpoint_auth_methods_supported[0], "none");
  assert.deepEqual(authorization.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
});

test("validates OpenAI CIMD metadata and exact callback and resource", async () => {
  const request = await validateMcpAuthorizationRequest(authorizationInput(), {
    env: ENV,
    fetchImpl: clientMetadataFetch,
  });
  assert.equal(request.clientId, CLIENT_ID);
  assert.equal(request.clientName, "ChatGPT");
  assert.equal(request.redirectUri, REDIRECT_URI);
  assert.deepEqual(request.scopes, [MCP_READ_SCOPE]);

  await assert.rejects(
    validateMcpAuthorizationRequest(
      { ...authorizationInput(), resource: "https://attacker.example/mcp" },
      { env: ENV, fetchImpl: clientMetadataFetch },
    ),
    (error) => error.code === "invalid_target",
  );
});

test("exchanges a one-time PKCE code for an opaque owner-scoped token", async () => {
  const request = await validateMcpAuthorizationRequest(
    authorizationInput([MCP_READ_SCOPE, MCP_GITHUB_WRITE_SCOPE]),
    { env: ENV, fetchImpl: clientMetadataFetch },
  );
  const code = createMcpAuthorizationCode(
    request,
    {
      id: "owner-id",
      memoryOwnerId: "primary-user",
      role: "owner",
    },
    ENV,
  );
  const input = {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    resource: ENV.MCP_RESOURCE_URL,
  };
  const token = await exchangeMcpAuthorizationCode(input, ENV);
  assert.equal(token.token_type, "Bearer");
  assert.doesNotMatch(token.access_token, /owner-id|primary-user/u);
  assert.deepEqual(
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_GITHUB_WRITE_SCOPE],
      ENV,
    ),
    {
      id: "owner-id",
      memoryOwnerId: "primary-user",
      role: "owner",
      scopes: [MCP_READ_SCOPE, MCP_GITHUB_WRITE_SCOPE],
      clientId: CLIENT_ID,
    },
  );
  const refreshed = await exchangeMcpRefreshToken(
    {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
      resource: ENV.MCP_RESOURCE_URL,
    },
    ENV,
  );
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, token.refresh_token);
  await assert.rejects(
    () =>
      exchangeMcpRefreshToken(
        {
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: CLIENT_ID,
          resource: ENV.MCP_RESOURCE_URL,
        },
        ENV,
      ),
    (error) => error.code === "invalid_grant",
  );
  await assert.rejects(
    () => exchangeMcpAuthorizationCode(input, ENV),
    (error) => error.code === "invalid_grant",
  );
});

test("blocks write authorization for a tester identity", async () => {
  const request = await validateMcpAuthorizationRequest(
    authorizationInput([MCP_GITHUB_WRITE_SCOPE]),
    { env: ENV, fetchImpl: clientMetadataFetch },
  );
  assert.throws(
    () =>
      createMcpAuthorizationCode(
        request,
        {
          id: "tester-id",
          memoryOwnerId: "supabase:tester-id",
          role: "tester",
        },
        ENV,
      ),
    (error) => error.code === "access_denied",
  );
});

test("distinguishes an invalid token from a valid token without scope", async () => {
  assert.throws(
    () => verifyMcpAccessToken("Bearer invalid-token", [MCP_READ_SCOPE], ENV),
    (error) => error.code === "invalid_token" && error.status === 401,
  );

  const request = await validateMcpAuthorizationRequest(
    authorizationInput([MCP_READ_SCOPE]),
    { env: ENV, fetchImpl: clientMetadataFetch },
  );
  const code = createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    ENV,
  );
  const token = await exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: ENV.MCP_RESOURCE_URL,
    },
    ENV,
  );
  assert.throws(
    () =>
      verifyMcpAccessToken(
        `Bearer ${token.access_token}`,
        [MCP_GITHUB_WRITE_SCOPE],
        ENV,
      ),
    (error) => error.code === "insufficient_scope" && error.status === 403,
  );
});

test("rejects an invalid PKCE verifier without consuming the code", async () => {
  const request = await validateMcpAuthorizationRequest(authorizationInput(), {
    env: ENV,
    fetchImpl: clientMetadataFetch,
  });
  const code = createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    ENV,
  );
  const base = {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: ENV.MCP_RESOURCE_URL,
  };
  await assert.rejects(
    () =>
      exchangeMcpAuthorizationCode(
        { ...base, code_verifier: "x".repeat(64) },
        ENV,
      ),
    (error) => error.code === "invalid_grant",
  );
  assert.ok(
    (
      await exchangeMcpAuthorizationCode(
        { ...base, code_verifier: VERIFIER },
        ENV,
      )
    ).access_token,
  );
});

test("refresh tokens survive a fresh application module instance", async () => {
  const first =
    await import("../src/services/mcpOAuthService.js?oauth-instance=first");
  const second =
    await import("../src/services/mcpOAuthService.js?oauth-instance=second");
  const request = {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    resource: ENV.MCP_RESOURCE_URL,
    scopes: [MCP_READ_SCOPE],
  };
  const code = first.createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    ENV,
  );
  const token = await first.exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: ENV.MCP_RESOURCE_URL,
    },
    ENV,
  );

  const refreshed = await second.exchangeMcpRefreshToken(
    {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
      resource: ENV.MCP_RESOURCE_URL,
    },
    ENV,
  );
  assert.ok(refreshed.access_token);
});

test("production replay guard is atomic across local state resets", async () => {
  const seen = new Set();
  const client = {
    async create({ id }) {
      if (seen.has(id)) {
        const error = new Error("version conflict");
        error.meta = { statusCode: 409 };
        throw error;
      }
      seen.add(id);
    },
  };
  const input = {
    grantType: "refresh_token",
    tokenId: "one-time-token-id",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    env: { ...ENV, NODE_ENV: "production" },
    client,
  };

  assert.equal(await consumeMcpGrantOnce(input), true);
  resetMcpOAuthStateForTests();
  assert.equal(await consumeMcpGrantOnce(input), false);
});

test("production OAuth fails closed without the durable replay store", async () => {
  assert.equal(
    requiresPersistentMcpReplayGuard({ NODE_ENV: "production" }),
    true,
  );
  await assert.rejects(
    consumeMcpGrantOnce({
      grantType: "authorization_code",
      tokenId: "code-id",
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      env: { ...ENV, NODE_ENV: "production" },
      client: null,
    }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("expired durable replay records are cleaned on a bounded schedule", async () => {
  const calls = [];
  const client = {
    async deleteByQuery(input) {
      calls.push(input);
      return { deleted: 2 };
    },
  };
  const env = {
    ...ENV,
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-test",
  };

  assert.equal(
    await cleanupExpiredMcpReplayRecords({ client, env, now: 1_000 }),
    true,
  );
  assert.equal(
    await cleanupExpiredMcpReplayRecords({ client, env, now: 1_001 }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, "oauth-replay-test");
  assert.deepEqual(calls[0].body.query, {
    range: { expiresAt: { lte: new Date(1_000_000).toISOString() } },
  });

  assert.equal(
    await cleanupExpiredMcpReplayRecords({
      client,
      env,
      now: 1_001,
      force: true,
    }),
    true,
  );
  assert.equal(calls.length, 2);
});
