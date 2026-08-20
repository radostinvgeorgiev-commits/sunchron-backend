import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  assertMcpGrantActive,
  cleanupExpiredMcpReplayRecords,
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
  MCP_MEMORY_WRITE_SCOPE,
  MCP_OFFLINE_ACCESS_SCOPE,
  MCP_READ_SCOPE,
  MCP_TASKS_WRITE_SCOPE,
  requiresPersistentMcpReplayGuard,
  requiresPersistentMcpGrantStore,
  resetMcpOAuthStateForTests,
  revokeMcpGrants,
  validateMcpAuthorizationRequest,
  verifyMcpAccessToken,
} from "../src/services/mcpOAuthService.js";

const ENV = {
  MCP_ACCESS_TOKEN: "mcp-oauth-test-secret-with-more-than-32-characters",
  MCP_RESOURCE_URL: "https://cloudaicore.com/mcp",
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

function openSearchError(statusCode, type) {
  const error = new Error(`OpenSearch ${statusCode}`);
  error.meta = {
    statusCode,
    ...(type ? { body: { error: { type } } } : {}),
  };
  return error;
}

function matchesOpenSearchQuery(source, query = {}) {
  const bool = query.bool || {};
  for (const clause of bool.filter || []) {
    if (clause.term) {
      const [field, value] = Object.entries(clause.term)[0];
      if (source[field] !== value) return false;
    }
    if (clause.range) {
      const [field, bounds] = Object.entries(clause.range)[0];
      const value = Date.parse(source[field]);
      if (bounds.gt && !(value > Date.parse(bounds.gt))) return false;
      if (bounds.lte && !(value <= Date.parse(bounds.lte))) return false;
    }
  }
  for (const clause of bool.must_not || []) {
    if (clause.exists && source[clause.exists.field] != null) return false;
  }
  if (query.range) {
    const [field, bounds] = Object.entries(query.range)[0];
    const value = Date.parse(source[field]);
    if (bounds.gt && !(value > Date.parse(bounds.gt))) return false;
    if (bounds.lte && !(value <= Date.parse(bounds.lte))) return false;
  }
  return true;
}

function createFakeOpenSearch() {
  const indexes = new Map();
  const mappings = new Map();
  const indexRecords = (index) => {
    const records = indexes.get(index);
    if (!records) throw openSearchError(404);
    return records;
  };
  const client = {
    indexes,
    mappings,
    indices: {
      async exists({ index }) {
        return { body: indexes.has(index) };
      },
      async create({ index, body }) {
        if (indexes.has(index)) {
          throw openSearchError(400, "resource_already_exists_exception");
        }
        indexes.set(index, new Map());
        mappings.set(index, structuredClone(body?.mappings || {}));
        return { body: { acknowledged: true } };
      },
    },
    async create({ index, id, body }) {
      const records = indexRecords(index);
      if (records.has(id)) throw openSearchError(409);
      records.set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async get({ index, id }) {
      const record = indexRecords(index).get(id);
      if (!record) throw openSearchError(404);
      return { body: { _id: id, _source: structuredClone(record) } };
    },
    async search({ index, body }) {
      const records = indexRecords(index);
      const hits = [...records]
        .filter(([, source]) => matchesOpenSearchQuery(source, body.query))
        .map(([id, source]) => ({ _id: id, _source: structuredClone(source) }))
        .sort((left, right) =>
          String(right._source.issuedAt || "").localeCompare(
            String(left._source.issuedAt || ""),
          ),
        )
        .slice(0, body.size);
      return { body: { hits: { hits } } };
    },
    async update({ index, id, body }) {
      const records = indexRecords(index);
      const record = records.get(id);
      if (!record) throw openSearchError(404);
      records.set(id, { ...record, ...structuredClone(body.doc || {}) });
      return { body: { result: "updated" } };
    },
    async updateByQuery({ index, body }) {
      const records = indexRecords(index);
      let updated = 0;
      for (const [id, source] of records) {
        if (!matchesOpenSearchQuery(source, body.query)) continue;
        records.set(id, { ...source, revokedAt: body.script.params.revokedAt });
        updated += 1;
      }
      return { body: { updated } };
    },
    async deleteByQuery({ index, body }) {
      const records = indexRecords(index);
      let deleted = 0;
      for (const [id, source] of records) {
        if (!matchesOpenSearchQuery(source, body.query)) continue;
        records.delete(id);
        deleted += 1;
      }
      return { body: { deleted } };
    },
  };
  return client;
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
    iss: "https://cloudaicore.com",
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
    authorization_servers: ["https://cloudaicore.com"],
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
    ],
  });
  const authorization = getMcpAuthorizationServerMetadata(ENV);
  assert.equal(
    authorization.authorization_endpoint,
    "https://cloudaicore.com/oauth/authorize",
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
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-persist-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-persist-test",
  };
  const client = createFakeOpenSearch();
  const realDateNow = Date.now;
  let now = realDateNow();
  Date.now = () => now;
  try {
    const token = await issueTokens(env, { client });
    const identity = verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      env,
    );
    const initial = await assertMcpGrantActive(identity, { env, client, now });

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
      client.mappings.get(env.MCP_OAUTH_GRANT_INDEX).properties.expiresAt,
      { type: "date" },
    );
    assert.deepEqual(await listActiveMcpGrants({ subject: "owner-id", env, client, now }), [
      initial,
    ]);

    now += 60_000;
    const refreshed = await exchangeMcpRefreshToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: CLIENT_ID,
        resource: ENV.MCP_RESOURCE_URL,
      },
      env,
      { client },
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
      client,
      now,
    });
    assert.ok(Date.parse(extended.expiresAt) > Date.parse(initial.expiresAt));
    assert.equal(
      extended.lastUsedAt,
      new Date(Math.floor(now / 1_000) * 1_000).toISOString(),
    );

    client.indexes.get(env.MCP_OAUTH_GRANT_INDEX).set(identity.grantId, {
      ...extended,
      expiresAt: new Date(now - 1).toISOString(),
    });
    assert.deepEqual(
      await listActiveMcpGrants({ subject: "owner-id", env, client, now }),
      [],
    );
  } finally {
    Date.now = realDateNow;
  }
});

test("a transient grant update failure does not consume the refresh token", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-refresh-retry-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-refresh-retry-test",
  };
  const client = createFakeOpenSearch();
  const token = await issueTokens(env, { client });
  const update = client.update.bind(client);
  let failUpdate = true;
  client.update = async (input) => {
    if (failUpdate) {
      failUpdate = false;
      throw openSearchError(503);
    }
    return update(input);
  };
  const refreshInput = {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: CLIENT_ID,
    resource: ENV.MCP_RESOURCE_URL,
  };

  await assert.rejects(
    exchangeMcpRefreshToken(refreshInput, env, { client }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
  const retried = await exchangeMcpRefreshToken(refreshInput, env, { client });
  assert.ok(retried.access_token);
  assert.ok(retried.refresh_token);
});

test("revokes one or all owner grants and blocks access and refresh", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-revoke-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-revoke-test",
  };
  const client = createFakeOpenSearch();
  const first = await issueTokens(env, { client });
  const second = await issueTokens(env, { client });
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
      client,
    }),
    1,
  );
  assert.deepEqual(
    (await listActiveMcpGrants({ subject: "owner-id", env, client })).map(
      ({ grantId }) => grantId,
    ),
    [secondIdentity.grantId],
  );
  await assert.rejects(
    assertMcpGrantActive(firstIdentity, { env, client }),
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
      { client },
    ),
    (error) => error.code === "invalid_grant" && error.status === 400,
  );
  assert.equal(
    await revokeMcpGrants({ subject: "owner-id", env, client }),
    1,
  );
  assert.deepEqual(
    await listActiveMcpGrants({ subject: "owner-id", env, client }),
    [],
  );
});

test("retries and verifies a target revoke after a version conflict", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-revoke-conflict-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-revoke-conflict-test",
  };
  const client = createFakeOpenSearch();
  const token = await issueTokens(env, { client });
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  const updateByQuery = client.updateByQuery.bind(client);
  let attempts = 0;
  client.updateByQuery = async (input) => {
    attempts += 1;
    if (attempts === 1) {
      return { body: { updated: 0, version_conflicts: 1 } };
    }
    const response = await updateByQuery(input);
    response.body.version_conflicts = 0;
    return response;
  };

  assert.equal(
    await revokeMcpGrants({
      subject: "owner-id",
      grantId: identity.grantId,
      env,
      client,
    }),
    1,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(
    await listActiveMcpGrants({ subject: "owner-id", env, client }),
    [],
  );
  await assert.rejects(
    assertMcpGrantActive(identity, { env, client }),
    (error) => error.code === "invalid_token" && error.status === 401,
  );
});

test("fails closed when revoke-all version conflicts remain active", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-revoke-conflict-fail-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-revoke-conflict-fail-test",
  };
  const client = createFakeOpenSearch();
  await issueTokens(env, { client });
  let attempts = 0;
  client.updateByQuery = async () => {
    attempts += 1;
    return { body: { updated: 0, version_conflicts: 1 } };
  };

  await assert.rejects(
    revokeMcpGrants({ subject: "owner-id", env, client }),
    (error) =>
      error.code === "temporarily_unavailable" && error.status === 503,
  );
  assert.equal(attempts, 3);
});

test("production grant checks fail closed for missing durable state", async () => {
  const token = await issueTokens(ENV, {
    client: null,
    consumeGrant: async () => true,
  });
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-missing-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-missing-test",
  };
  const client = createFakeOpenSearch();
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  resetMcpOAuthStateForTests();

  await assert.rejects(
    assertMcpGrantActive(identity, { env, client }),
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
      { client },
    ),
    (error) => error.code === "invalid_grant" && error.status === 400,
  );
  await assert.rejects(
    assertMcpGrantActive(identity, { env, client: null }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("migrates pre-grant tokens without abruptly invalidating access", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-legacy-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-legacy-test",
  };
  const client = createFakeOpenSearch();
  const legacyIdentity = verifyMcpAccessToken(
    `Bearer ${createLegacyAccessToken()}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.equal(legacyIdentity.grantId, null);
  assert.equal(
    (await assertMcpGrantActive(legacyIdentity, { env, client })).legacy,
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
    { client },
  );
  const migratedIdentity = verifyMcpAccessToken(
    `Bearer ${migrated.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.match(migratedIdentity.grantId, /^legacy_[A-Za-z0-9_-]+$/u);
  assert.deepEqual(
    (await listActiveMcpGrants({ subject: "owner-id", env, client })).map(
      ({ grantId }) => grantId,
    ),
    [migratedIdentity.grantId],
  );
});

test("a revoked local grant stays revoked when a dev store returns 404", async () => {
  const env = {
    ...ENV,
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-dev-404-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-dev-404-test",
  };
  const client = createFakeOpenSearch();
  const token = await issueTokens(env, { client });
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
      client,
    }),
    1,
  );
  client.indexes.get(env.MCP_OAUTH_GRANT_INDEX).delete(identity.grantId);

  await assert.rejects(
    assertMcpGrantActive(identity, { env, client }),
    (error) => error.code === "invalid_token" && error.status === 401,
  );
});

test("rejects durable grants with malformed security timestamps", async () => {
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_GRANT_INDEX: "oauth-grants-invalid-time-test",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-invalid-time-test",
  };
  const client = createFakeOpenSearch();

  for (const field of ["issuedAt", "expiresAt"]) {
    const token = await issueTokens(env, { client });
    const identity = verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      [MCP_READ_SCOPE],
      env,
    );
    const records = client.indexes.get(env.MCP_OAUTH_GRANT_INDEX);
    records.set(identity.grantId, {
      ...records.get(identity.grantId),
      [field]: "not-a-timestamp",
    });

    await assert.rejects(
      assertMcpGrantActive(identity, { env, client }),
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
        { client },
      ),
      (error) => error.code === "invalid_grant" && error.status === 400,
    );
  }

  assert.deepEqual(
    await listActiveMcpGrants({ subject: "owner-id", env, client }),
    [],
  );
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

test("first production token exchange creates the durable replay index", async () => {
  const calls = [];
  const client = {
    indices: {
      async exists(input) {
        calls.push(["exists", input]);
        return { body: false };
      },
      async create(input) {
        calls.push(["create-index", input]);
      },
    },
    async create(input) {
      calls.push(["create-record", input]);
    },
    async deleteByQuery() {
      return { deleted: 0 };
    },
  };
  const env = {
    ...ENV,
    NODE_ENV: "production",
    MCP_OAUTH_REPLAY_INDEX: "oauth-replay-first-link-test",
  };

  assert.equal(
    await consumeMcpGrantOnce({
      grantType: "authorization_code",
      tokenId: "first-chatgpt-link",
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      env,
      client,
    }),
    true,
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ["exists", "create-index", "create-record"],
  );
  assert.equal(calls[1][1].index, "oauth-replay-first-link-test");
  assert.deepEqual(calls[1][1].body.mappings.properties, {
    grantType: { type: "keyword" },
    expiresAt: { type: "date" },
  });
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
