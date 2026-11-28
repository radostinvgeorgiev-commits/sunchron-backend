import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  assertMcpGrantActive,
  buildMcpAuthenticateChallenge,
  cleanupExpiredMcpReplayRecords,
  CHATGPT_MCP_SCOPE,
  consumeMcpGrantOnce,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  exchangeMcpToken,
  getMcpOpenAiTunnelRuntimeStatus,
  getMcpOAuthRuntimeStatus,
  getMcpOAuthSecretMode,
  getMcpAuthorizationServerMetadata,
  getMcpProtectedResourceMetadata,
  isMcpOAuthConfigured,
  listActiveMcpGrants,
  MCP_AGENT_CHAT_SCOPE,
  MCP_AUDIT_READ_SCOPE,
  MCP_GITHUB_WRITE_SCOPE,
  MCP_GOOGLE_READ_SCOPE,
  MCP_GOOGLE_WRITE_SCOPE,
  MCP_INFRASTRUCTURE_WRITE_SCOPE,
  MCP_MEDIA_WRITE_SCOPE,
  MCP_MEMORY_WRITE_SCOPE,
  MCP_OFFLINE_ACCESS_SCOPE,
  MCP_READ_SCOPE,
  MCP_TASKS_WRITE_SCOPE,
  requiresPersistentMcpReplayGuard,
  resolvePublicMcpUrl,
  requiresPersistentMcpGrantStore,
  resetMcpOAuthStateForTests,
  revokeMcpGrants,
  validateMcpAuthorizationRequest,
  verifyMcpAccessToken,
} from "../src/services/mcpOAuthService.js";
import { createFirestoreMcpOAuthStore } from "../src/services/firestoreMcpOAuthStore.js";
import { createLocalDocumentStore } from "../src/services/localDocumentStore.js";

const ENV = {
  MCP_ACCESS_TOKEN: "mcp-oauth-test-secret-with-more-than-32-characters",
  MCP_RESOURCE_URL: "https://novariumai.com/mcp",
};
const TUNNEL_RESOURCE =
  "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_test123";
const TUNNEL_ENV = {
  ...ENV,
  MCP_OPENAI_TUNNEL_RESOURCE_URL: TUNNEL_RESOURCE,
};
const DEDICATED_ENV = {
  ...ENV,
  MCP_OAUTH_SECRET: "dedicated-oauth-test-secret-with-more-than-32-characters",
};
const CLIENT_ID = "https://chatgpt.com/oauth/synchron/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/test-callback";
const VERIFIER = "v".repeat(64);

const FIRESTORE_ENV = Object.freeze({
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
});
const GRANT_COLLECTION = "synchron-mcp-oauth-grants-v1";

// The Firestore MCP OAuth store over an in-process document store, so the
// durable grant and replay records can be read and changed by a test.
function createDurableStore() {
  const documents = createLocalDocumentStore();
  const store = createFirestoreMcpOAuthStore({
    env: FIRESTORE_ENV,
    documentStore: documents,
  });
  return {
    store,
    async grant(id) {
      return (await documents.get(GRANT_COLLECTION, id))?.data || null;
    },
    setGrant(id, data) {
      return documents.set(GRANT_COLLECTION, id, data);
    },
    deleteGrant(id) {
      return documents.delete(GRANT_COLLECTION, id);
    },
  };
}

function productionEnv() {
  return { ...ENV, ...FIRESTORE_ENV, NODE_ENV: "production" };
}

// A store whose every call fails, as when Firestore is unreachable.
function unavailableStore() {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error("Firestore unavailable");
      },
    },
  );
}

function legacyOAuthKey(env = ENV) {
  return createHash("sha256")
    .update("synchron-mcp-oauth-v1\0")
    .update(env.MCP_ACCESS_TOKEN)
    .digest();
}

function legacyGrantKey(env = ENV) {
  return createHash("sha256")
    .update(legacyOAuthKey(env))
    .update("synchron-mcp-oauth-grants-v2\0")
    .digest();
}

function encryptLegacyToken(prefix, payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return `${prefix}.${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url")}`;
}

function legacyIdentityPayload(now = Math.floor(Date.now() / 1_000)) {
  return {
    iss: "https://novariumai.com",
    aud: ENV.MCP_RESOURCE_URL,
    clientId: CLIENT_ID,
    scopes: [MCP_READ_SCOPE],
    subject: "owner-id",
    memoryOwnerId: "primary-user",
    role: "owner",
    iat: now,
  };
}

function createLegacyAccessToken(now = Math.floor(Date.now() / 1_000)) {
  return encryptLegacyToken(
    "sx-token",
    {
      typ: "access_token",
      ...legacyIdentityPayload(now),
      nbf: now - 5,
      exp: now + 60 * 60,
    },
    legacyOAuthKey(),
  );
}

function createLegacyRefreshToken(now = Math.floor(Date.now() / 1_000)) {
  return encryptLegacyToken(
    "sx-refresh",
    {
      typ: "refresh_token",
      jti: randomBytes(18).toString("base64url"),
      ...legacyIdentityPayload(now),
      exp: now + 30 * 24 * 60 * 60,
    },
    legacyGrantKey(),
  );
}

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

async function issueTokens(env = ENV, options = {}) {
  const request = await validateMcpAuthorizationRequest(authorizationInput(), {
    env,
    fetchImpl: clientMetadataFetch,
  });
  const code = createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    env,
  );
  return exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: ENV.MCP_RESOURCE_URL,
    },
    env,
    options,
  );
}

test.beforeEach(() => resetMcpOAuthStateForTests());

test("publishes OAuth 2.1 protected-resource and authorization metadata", () => {
  assert.deepEqual(getMcpProtectedResourceMetadata(ENV), {
    resource: ENV.MCP_RESOURCE_URL,
    authorization_servers: ["https://novariumai.com"],
    scopes_supported: [
      MCP_READ_SCOPE,
      MCP_AGENT_CHAT_SCOPE,
      MCP_MEMORY_WRITE_SCOPE,
      MCP_TASKS_WRITE_SCOPE,
      MCP_GITHUB_WRITE_SCOPE,
      MCP_GOOGLE_READ_SCOPE,
      MCP_GOOGLE_WRITE_SCOPE,
      MCP_AUDIT_READ_SCOPE,
      MCP_INFRASTRUCTURE_WRITE_SCOPE,
      MCP_MEDIA_WRITE_SCOPE,
    ],
  });
  const authorization = getMcpAuthorizationServerMetadata(ENV);
  assert.equal(
    authorization.authorization_endpoint,
    "https://novariumai.com/oauth/authorize",
  );
  assert.equal(authorization.token_endpoint_auth_methods_supported[0], "none");
  assert.deepEqual(authorization.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(authorization.scopes_supported, [
    MCP_READ_SCOPE,
    MCP_AGENT_CHAT_SCOPE,
    MCP_MEMORY_WRITE_SCOPE,
    MCP_TASKS_WRITE_SCOPE,
    MCP_GITHUB_WRITE_SCOPE,
    MCP_GOOGLE_READ_SCOPE,
    MCP_GOOGLE_WRITE_SCOPE,
    MCP_AUDIT_READ_SCOPE,
    MCP_INFRASTRUCTURE_WRITE_SCOPE,
    MCP_MEDIA_WRITE_SCOPE,
    CHATGPT_MCP_SCOPE,
    MCP_OFFLINE_ACCESS_SCOPE,
  ]);
});

test("uses an explicit dedicated or legacy fallback OAuth key mode", () => {
  assert.equal(getMcpOAuthSecretMode(ENV), "legacy_fallback");
  assert.equal(getMcpOAuthSecretMode(DEDICATED_ENV), "dedicated");
  assert.equal(isMcpOAuthConfigured(DEDICATED_ENV), true);
  assert.equal(
    isMcpOAuthConfigured({
      MCP_OAUTH_SECRET: DEDICATED_ENV.MCP_OAUTH_SECRET,
      MCP_RESOURCE_URL: ENV.MCP_RESOURCE_URL,
    }),
    true,
  );
  assert.equal(
    isMcpOAuthConfigured({ ...ENV, MCP_OAUTH_SECRET: "too-short" }),
    false,
  );
  assert.throws(
    () =>
      createMcpAuthorizationCode(
        {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          codeChallenge: createHash("sha256")
            .update(VERIFIER)
            .digest("base64url"),
          resource: ENV.MCP_RESOURCE_URL,
          scopes: [MCP_READ_SCOPE],
        },
        { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
        { ...ENV, MCP_OAUTH_SECRET: "too-short" },
      ),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("dedicated mode accepts a legacy authorization code and issues dedicated tokens", async () => {
  const request = await validateMcpAuthorizationRequest(authorizationInput(), {
    env: ENV,
    fetchImpl: clientMetadataFetch,
  });
  const legacyCode = createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    ENV,
  );

  const token = await exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code: legacyCode,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: ENV.MCP_RESOURCE_URL,
    },
    DEDICATED_ENV,
  );

  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      DEDICATED_ENV,
    ).memoryOwnerId,
    "primary-user",
  );
  assert.throws(
    () =>
      verifyMcpAccessToken(
        `Bearer ${token.access_token}`,
        [MCP_READ_SCOPE],
        ENV,
      ),
    (error) => error.code === "invalid_token",
  );
});

test("dedicated tokens cannot be verified or refreshed with only the legacy key", async () => {
  const token = await issueTokens(DEDICATED_ENV);
  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      DEDICATED_ENV,
    ).memoryOwnerId,
    "primary-user",
  );
  assert.throws(
    () =>
      verifyMcpAccessToken(
        `Bearer ${token.access_token}`,
        [MCP_READ_SCOPE],
        ENV,
      ),
    (error) => error.code === "invalid_token",
  );
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
});

test("dedicated mode accepts legacy access and rotates legacy refresh tokens", async () => {
  const legacyToken = await issueTokens(ENV);
  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${legacyToken.access_token}`,
      [MCP_READ_SCOPE],
      DEDICATED_ENV,
    ).memoryOwnerId,
    "primary-user",
  );

  const rotated = await exchangeMcpRefreshToken(
    {
      grant_type: "refresh_token",
      refresh_token: legacyToken.refresh_token,
      client_id: CLIENT_ID,
      resource: ENV.MCP_RESOURCE_URL,
    },
    DEDICATED_ENV,
  );
  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${rotated.access_token}`,
      [MCP_READ_SCOPE],
      DEDICATED_ENV,
    ).memoryOwnerId,
    "primary-user",
  );
  assert.throws(
    () =>
      verifyMcpAccessToken(
        `Bearer ${rotated.access_token}`,
        [MCP_READ_SCOPE],
        ENV,
      ),
    (error) => error.code === "invalid_token",
  );
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

test("accepts only the configured OpenAI secure tunnel resource through the full token flow", async () => {
  resetMcpOAuthStateForTests();
  const tunnelInput = {
    ...authorizationInput(),
    resource: TUNNEL_RESOURCE,
  };
  const request = await validateMcpAuthorizationRequest(tunnelInput, {
    env: TUNNEL_ENV,
    fetchImpl: clientMetadataFetch,
  });
  assert.equal(request.resource, TUNNEL_RESOURCE);

  const code = createMcpAuthorizationCode(
    request,
    { id: "owner-id", memoryOwnerId: "primary-user", role: "owner" },
    TUNNEL_ENV,
  );
  const token = await exchangeMcpToken(
    {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: TUNNEL_RESOURCE,
    },
    TUNNEL_ENV,
  );
  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      TUNNEL_ENV,
    ).memoryOwnerId,
    "primary-user",
  );

  assert.equal(
    getMcpOpenAiTunnelRuntimeStatus(TUNNEL_ENV).endToEndVerified,
    true,
  );

  const refreshed = await exchangeMcpToken(
    {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
      resource: TUNNEL_RESOURCE,
    },
    TUNNEL_ENV,
  );
  assert.equal(
    verifyMcpAccessToken(
      `Bearer ${refreshed.access_token}`,
      [MCP_READ_SCOPE],
      TUNNEL_ENV,
    ).memoryOwnerId,
    "primary-user",
  );
  assert.equal(
    getMcpOpenAiTunnelRuntimeStatus(TUNNEL_ENV).tokenExchange,
    "success",
  );

  await assert.rejects(
    validateMcpAuthorizationRequest(
      {
        ...tunnelInput,
        resource:
          "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_other",
      },
      { env: TUNNEL_ENV, fetchImpl: clientMetadataFetch },
    ),
    (error) => error.code === "invalid_target",
  );
  await assert.rejects(
    validateMcpAuthorizationRequest(
      { ...tunnelInput, resource: "https://attacker.example/mcp" },
      {
        env: {
          ...ENV,
          MCP_OPENAI_TUNNEL_RESOURCE_URL: "https://attacker.example/mcp",
        },
        fetchImpl: clientMetadataFetch,
      },
    ),
    (error) => error.code === "invalid_target",
  );
});

test("accepts offline_access for ChatGPT refresh-token continuity", async () => {
  const request = await validateMcpAuthorizationRequest(
    authorizationInput([MCP_READ_SCOPE, MCP_OFFLINE_ACCESS_SCOPE]),
    { env: ENV, fetchImpl: clientMetadataFetch },
  );
  assert.deepEqual(request.scopes, [MCP_READ_SCOPE, MCP_OFFLINE_ACCESS_SCOPE]);

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

  assert.ok(token.refresh_token);
  assert.equal(token.scope, `${MCP_READ_SCOPE} ${MCP_OFFLINE_ACCESS_SCOPE}`);
  assert.equal(
    verifyMcpAccessToken(`Bearer ${token.access_token}`, [MCP_READ_SCOPE], ENV)
      .memoryOwnerId,
    "primary-user",
  );
});

test("uses a pinned ChatGPT client policy when CIMD retrieval is unavailable", async () => {
  const request = await validateMcpAuthorizationRequest(authorizationInput(), {
    env: ENV,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  assert.equal(request.clientId, CLIENT_ID);
  assert.equal(request.clientName, "ChatGPT");
  assert.equal(request.redirectUri, REDIRECT_URI);
  assert.deepEqual(request.scopes, [MCP_READ_SCOPE]);
});

test("does not apply the ChatGPT fallback outside pinned OAuth paths", async () => {
  const unavailable = async () => {
    throw new Error("network unavailable");
  };

  await assert.rejects(
    validateMcpAuthorizationRequest(
      {
        ...authorizationInput(),
        client_id: "https://chatgpt.com/not-oauth/client.json",
      },
      { env: ENV, fetchImpl: unavailable },
    ),
    (error) =>
      error.code === "invalid_client" &&
      error.description === "OAuth клиентът не може да бъде проверен.",
  );

  await assert.rejects(
    validateMcpAuthorizationRequest(
      {
        ...authorizationInput(),
        redirect_uri: "https://chatgpt.com/not-a-connector/callback",
      },
      { env: ENV, fetchImpl: unavailable },
    ),
    (error) =>
      error.code === "invalid_client" &&
      error.description === "OAuth клиентът не може да бъде проверен.",
  );
});

test("the connector also works at novariumai.com/mcp, signing in at the same place", async () => {
  const NEW = "https://novariumai.com/mcp";
  const meta = getMcpProtectedResourceMetadata(ENV, { host: "novariumai.com" });
  assert.equal(meta.resource, NEW);
  assert.deepEqual(meta.authorization_servers, ["https://novariumai.com"]);
  assert.equal(getMcpProtectedResourceMetadata(ENV, { host: "evil.example" }).resource, ENV.MCP_RESOURCE_URL);
  assert.match(
    buildMcpAuthenticateChallenge([MCP_READ_SCOPE], ENV, { host: "novariumai.com" }),
    /resource_metadata="https:\/\/novariumai\.com\/\.well-known\/oauth-protected-resource"/u,
  );
  const request = await validateMcpAuthorizationRequest(
    { ...authorizationInput([MCP_READ_SCOPE]), resource: NEW },
    { env: ENV, fetchImpl: clientMetadataFetch },
  );
  const code = createMcpAuthorizationCode(request, { id: "o", memoryOwnerId: "u", role: "owner" }, ENV);
  const token = await exchangeMcpAuthorizationCode(
    { grant_type: "authorization_code", code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code_verifier: VERIFIER, resource: NEW },
    ENV,
  );
  assert.equal(verifyMcpAccessToken(`Bearer ${token.access_token}`, [MCP_READ_SCOPE], ENV).memoryOwnerId, "u");
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
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    [MCP_GITHUB_WRITE_SCOPE],
    ENV,
  );
  assert.match(identity.grantId, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(
    { ...identity, grantId: undefined },
    {
      id: "owner-id",
      memoryOwnerId: "primary-user",
      role: "owner",
      scopes: [MCP_READ_SCOPE, MCP_GITHUB_WRITE_SCOPE],
      clientId: CLIENT_ID,
      grantId: undefined,
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

test("blocks every owner-only authorization for a tester identity", async () => {
  for (const scope of [
    MCP_GITHUB_WRITE_SCOPE,
    MCP_GOOGLE_READ_SCOPE,
    MCP_GOOGLE_WRITE_SCOPE,
    MCP_AUDIT_READ_SCOPE,
    MCP_INFRASTRUCTURE_WRITE_SCOPE,
    MCP_MEDIA_WRITE_SCOPE,
  ]) {
    const request = await validateMcpAuthorizationRequest(
      authorizationInput([scope]),
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
  }
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

test("persists a bounded owner grant and extends it on refresh", async () => {
  const env = productionEnv();
  const durable = createDurableStore();
  const firestoreStore = durable.store;
  const realDateNow = Date.now;
  let now = realDateNow();
  Date.now = () => now;
  try {
    const token = await issueTokens(env, { firestoreStore });
    const identity = verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      env,
    );
    const initial = await assertMcpGrantActive(identity, {
      env,
      firestoreStore,
      now,
    });

    assert.equal(requiresPersistentMcpGrantStore(env), true);
    assert.deepEqual(
      {
        grantId: initial.grantId,
        subject: initial.subject,
        memoryOwnerId: initial.memoryOwnerId,
        role: initial.role,
        clientId: initial.clientId,
        scopes: initial.scopes,
        lastUsedAt: initial.lastUsedAt,
        revokedAt: initial.revokedAt,
      },
      {
        grantId: identity.grantId,
        subject: "owner-id",
        memoryOwnerId: "primary-user",
        role: "owner",
        clientId: CLIENT_ID,
        scopes: [MCP_READ_SCOPE],
        lastUsedAt: null,
        revokedAt: null,
      },
    );
    assert.match(initial.issuedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(Date.parse(initial.expiresAt) > now);
    assert.deepEqual(
      await listActiveMcpGrants({
        subject: "owner-id",
        env,
        firestoreStore,
        now,
      }),
      [initial],
    );

    now += 60_000;
    const refreshed = await exchangeMcpRefreshToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: CLIENT_ID,
        resource: ENV.MCP_RESOURCE_URL,
      },
      env,
      { firestoreStore },
    );
    const refreshedIdentity = verifyMcpAccessToken(
      `Bearer ${refreshed.access_token}`,
      [MCP_READ_SCOPE],
      env,
    );
    assert.equal(refreshedIdentity.grantId, identity.grantId);
    const [extended] = await listActiveMcpGrants({
      subject: "owner-id",
      env,
      firestoreStore,
      now,
    });
    assert.ok(Date.parse(extended.expiresAt) > Date.parse(initial.expiresAt));
    assert.equal(
      extended.lastUsedAt,
      new Date(Math.floor(now / 1_000) * 1_000).toISOString(),
    );

    await durable.setGrant(identity.grantId, {
      ...(await durable.grant(identity.grantId)),
      expiresAt: new Date(now - 1).toISOString(),
    });
    assert.deepEqual(
      await listActiveMcpGrants({
        subject: "owner-id",
        env,
        firestoreStore,
        now,
      }),
      [],
    );
  } finally {
    Date.now = realDateNow;
  }
});

test("a transient grant update failure does not consume the refresh token", async () => {
  const env = productionEnv();
  const { store } = createDurableStore();
  let failUpdate = false;
  const firestoreStore = {
    ...store,
    async mutateGrant(...input) {
      if (failUpdate) {
        failUpdate = false;
        throw new Error("Firestore unavailable");
      }
      return store.mutateGrant(...input);
    },
  };
  const token = await issueTokens(env, { firestoreStore });
  failUpdate = true;
  const refreshInput = {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: CLIENT_ID,
    resource: ENV.MCP_RESOURCE_URL,
  };

  await assert.rejects(
    exchangeMcpRefreshToken(refreshInput, env, { firestoreStore }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
  const retried = await exchangeMcpRefreshToken(refreshInput, env, {
    firestoreStore,
  });
  assert.ok(retried.access_token);
  assert.ok(retried.refresh_token);
});

test("revokes one or all owner grants and blocks access and refresh", async () => {
  const env = productionEnv();
  const firestoreStore = createDurableStore().store;
  const first = await issueTokens(env, { firestoreStore });
  const second = await issueTokens(env, { firestoreStore });
  const firstIdentity = verifyMcpAccessToken(
    `Bearer ${first.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  const secondIdentity = verifyMcpAccessToken(
    `Bearer ${second.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );

  assert.equal(
    await revokeMcpGrants({
      subject: "owner-id",
      grantId: firstIdentity.grantId,
      env,
      firestoreStore,
    }),
    1,
  );
  assert.deepEqual(
    (
      await listActiveMcpGrants({ subject: "owner-id", env, firestoreStore })
    ).map(({ grantId }) => grantId),
    [secondIdentity.grantId],
  );
  await assert.rejects(
    assertMcpGrantActive(firstIdentity, { env, firestoreStore }),
    (error) => error.code === "invalid_token" && error.status === 401,
  );
  await assert.rejects(
    exchangeMcpRefreshToken(
      {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLIENT_ID,
        resource: ENV.MCP_RESOURCE_URL,
      },
      env,
      { firestoreStore },
    ),
    (error) => error.code === "invalid_grant" && error.status === 400,
  );
  assert.equal(
    await revokeMcpGrants({ subject: "owner-id", env, firestoreStore }),
    1,
  );
  assert.deepEqual(
    await listActiveMcpGrants({ subject: "owner-id", env, firestoreStore }),
    [],
  );
});

test("production grant checks fail closed for missing durable state", async () => {
  const token = await issueTokens(ENV, {
    consumeGrant: async () => true,
  });
  const env = productionEnv();
  const firestoreStore = createDurableStore().store;
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  resetMcpOAuthStateForTests();

  await assert.rejects(
    assertMcpGrantActive(identity, { env, firestoreStore }),
    (error) => error.code === "invalid_token" && error.status === 401,
  );
  await assert.rejects(
    exchangeMcpRefreshToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: CLIENT_ID,
        resource: ENV.MCP_RESOURCE_URL,
      },
      env,
      { firestoreStore },
    ),
    (error) => error.code === "invalid_grant" && error.status === 400,
  );
  await assert.rejects(
    assertMcpGrantActive(identity, {
      env,
      firestoreStore: unavailableStore(),
    }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("migrates pre-grant tokens without abruptly invalidating access", async () => {
  const env = productionEnv();
  const firestoreStore = createDurableStore().store;
  const legacyIdentity = verifyMcpAccessToken(
    `Bearer ${createLegacyAccessToken()}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.equal(legacyIdentity.grantId, null);
  assert.equal(
    (await assertMcpGrantActive(legacyIdentity, { env, firestoreStore }))
      .legacy,
    true,
  );

  const migrated = await exchangeMcpRefreshToken(
    {
      grant_type: "refresh_token",
      refresh_token: createLegacyRefreshToken(),
      client_id: CLIENT_ID,
      resource: ENV.MCP_RESOURCE_URL,
    },
    env,
    { firestoreStore },
  );
  const migratedIdentity = verifyMcpAccessToken(
    `Bearer ${migrated.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.match(migratedIdentity.grantId, /^legacy_[A-Za-z0-9_-]+$/u);
  assert.deepEqual(
    (
      await listActiveMcpGrants({ subject: "owner-id", env, firestoreStore })
    ).map(({ grantId }) => grantId),
    [migratedIdentity.grantId],
  );
});

test("a revoked local grant stays revoked when a dev store loses the record", async () => {
  const env = { ...ENV, ...FIRESTORE_ENV };
  const durable = createDurableStore();
  const firestoreStore = durable.store;
  const token = await issueTokens(env, { firestoreStore });
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.equal(
    await revokeMcpGrants({
      subject: "owner-id",
      grantId: identity.grantId,
      env,
      firestoreStore,
    }),
    1,
  );
  await durable.deleteGrant(identity.grantId);

  await assert.rejects(
    assertMcpGrantActive(identity, { env, firestoreStore }),
    (error) => error.code === "invalid_token" && error.status === 401,
  );
});

test("rejects durable grants with malformed security timestamps", async () => {
  const env = productionEnv();
  const durable = createDurableStore();
  const firestoreStore = durable.store;

  for (const field of ["issuedAt", "expiresAt"]) {
    const token = await issueTokens(env, { firestoreStore });
    const identity = verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      env,
    );
    await durable.setGrant(identity.grantId, {
      ...(await durable.grant(identity.grantId)),
      [field]: "not-a-timestamp",
    });

    await assert.rejects(
      assertMcpGrantActive(identity, { env, firestoreStore }),
      (error) => error.code === "invalid_token" && error.status === 401,
    );
    await assert.rejects(
      exchangeMcpRefreshToken(
        {
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: CLIENT_ID,
          resource: ENV.MCP_RESOURCE_URL,
        },
        env,
        { firestoreStore },
      ),
      (error) => error.code === "invalid_grant" && error.status === 400,
    );
  }

  assert.deepEqual(
    await listActiveMcpGrants({ subject: "owner-id", env, firestoreStore }),
    [],
  );
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
      env: productionEnv(),
      firestoreStore: unavailableStore(),
    }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("OAuth runtime diagnostics expose only a safe token exchange result", async () => {
  await assert.rejects(
    exchangeMcpToken({ grant_type: "unsupported" }, ENV),
    (error) => error.code === "unsupported_grant_type",
  );
  const status = getMcpOAuthRuntimeStatus();
  assert.equal(status.tokenExchange, "failed");
  assert.equal(status.grantType, "unsupported");
  assert.equal(status.errorCode, "unsupported_grant_type");
  assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(Object.keys(status).sort(), [
    "authorization",
    "authorizationDecision",
    "authorizationErrorCode",
    "authorizationUpdatedAt",
    "errorCode",
    "grantType",
    "tokenExchange",
    "updatedAt",
  ]);
});

test("expired durable replay records are cleaned on a bounded schedule", async () => {
  const calls = [];
  const firestoreStore = {
    async cleanupExpiredReplay(now) {
      calls.push(now);
    },
  };
  const env = { ...ENV, ...FIRESTORE_ENV };

  assert.equal(
    await cleanupExpiredMcpReplayRecords({ firestoreStore, env, now: 1_000 }),
    true,
  );
  assert.equal(
    await cleanupExpiredMcpReplayRecords({ firestoreStore, env, now: 1_001 }),
    false,
  );
  assert.deepEqual(calls, [1_000]);

  assert.equal(
    await cleanupExpiredMcpReplayRecords({
      firestoreStore,
      env,
      now: 1_001,
      force: true,
    }),
    true,
  );
  assert.deepEqual(calls, [1_000, 1_001]);
});

test("ChatGPT plugin grants are scoped to the public plugin resource", async () => {
  const resource = "https://novariumai.com/mcp/chatgpt";
  const input = { ...authorizationInput(), resource, scope: CHATGPT_MCP_SCOPE };
  const options = { env: ENV, fetchImpl: clientMetadataFetch };
  await assert.rejects(
    validateMcpAuthorizationRequest({ ...input, scope: `${CHATGPT_MCP_SCOPE} ${MCP_READ_SCOPE}` }, options),
    { code: "invalid_scope" },
  );
  await assert.rejects(
    validateMcpAuthorizationRequest({ ...input, resource: ENV.MCP_RESOURCE_URL }, options),
    { code: "invalid_scope" },
  );

  const request = await validateMcpAuthorizationRequest(input, options);
  const code = createMcpAuthorizationCode(
    request,
    { id: "plugin-member", memoryOwnerId: "identity-platform:plugin-member", role: "member" },
    ENV,
  );
  const token = await exchangeMcpAuthorizationCode({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    resource,
  }, ENV);

  const header = `Bearer ${token.access_token}`;
  assert.equal(verifyMcpAccessToken(header, [CHATGPT_MCP_SCOPE], ENV, { expectedResource: resource }).role, "member");
  assert.throws(() => verifyMcpAccessToken(header, [CHATGPT_MCP_SCOPE], ENV), { code: "invalid_token" });
  assert.throws(() => verifyMcpAccessToken(header, [CHATGPT_MCP_SCOPE], ENV, { expectedResource: ENV.MCP_RESOURCE_URL }), { code: "invalid_token" });
});

test("people are shown the novariumai.com connector address, never the old one", () => {
  // Today: the old address is still the canonical resource.
  assert.equal(
    resolvePublicMcpUrl({ MCP_RESOURCE_URL: "https://novariumai.com/mcp" }),
    "https://novariumai.com/mcp",
  );
  // After the resource moves, the same address.
  assert.equal(
    resolvePublicMcpUrl({ MCP_RESOURCE_URL: "https://novariumai.com/mcp" }),
    "https://novariumai.com/mcp",
  );
  assert.equal(resolvePublicMcpUrl({}), "https://novariumai.com/mcp");
});
