import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createFirestoreMcpOAuthStore } from "../src/services/firestoreMcpOAuthStore.js";
import { createFirestoreOAuthSessionStore } from "../src/services/firestoreOAuthSessionStore.js";
import {
  createGitHubSession,
  getGitHubSession,
  resetGitHubSessionsForTests,
  setFirestoreGitHubSessionStoreForTests,
} from "../src/services/githubOAuthService.js";
import {
  createSession as createGoogleSession,
  hasSession as hasGoogleSession,
  resetGoogleSessionsForTests,
  setFirestoreGoogleSessionStoreForTests,
} from "../src/services/googleDriveService.js";
import {
  assertMcpGrantActive,
  consumeMcpGrantOnce,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  listActiveMcpGrants,
  MCP_READ_SCOPE,
  resetMcpOAuthStateForTests,
  revokeMcpGrants,
  verifyMcpAccessToken,
} from "../src/services/mcpOAuthService.js";

const GCP_ENV = Object.freeze({
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
  PERSISTENCE_BACKEND: "firestore",
});

function conflict(status = "FAILED_PRECONDITION") {
  const error = new Error("Firestore conflict");
  error.code = "FIRESTORE_UNAVAILABLE";
  error.status = 503;
  error.upstreamStatus = status === "ALREADY_EXISTS" ? 409 : 400;
  error.upstreamErrorStatus = status;
  return error;
}

function createFakeDocumentStore() {
  const collections = new Map();
  let version = 0;
  const control = {
    failSetConflicts: 0,
    failCommitConflicts: 0,
    alwaysCommitConflict: false,
    commitCalls: 0,
  };
  const records = (collection) => {
    if (!collections.has(collection)) collections.set(collection, new Map());
    return collections.get(collection);
  };
  const nextUpdateTime = () => {
    version += 1;
    return `2026-08-10T00:00:00.${String(version).padStart(6, "0")}Z`;
  };
  const result = (id, record, includeMetadata = false) => ({
    id,
    data: structuredClone(record.data),
    ...(includeMetadata ? { updateTime: record.updateTime } : {}),
  });
  const verifyPrecondition = (record, operation) => {
    if (operation.createOnly && record) throw conflict("ALREADY_EXISTS");
    if (operation.updateTime && record?.updateTime !== operation.updateTime) {
      throw conflict();
    }
    if (operation.mustExist && !record) throw conflict();
  };
  const matches = (data, filter) => {
    if ((filter.op || "EQUAL") === "EQUAL") {
      return data[filter.field] === filter.value;
    }
    if (filter.op === "LESS_THAN_OR_EQUAL") {
      return Number(data[filter.field]) <= Number(filter.value);
    }
    throw new Error(`Unsupported fake filter: ${filter.op}`);
  };

  return {
    collections,
    control,
    async get(collection, id, options = {}) {
      const record = records(collection).get(id);
      return record ? result(id, record, options.includeMetadata) : null;
    },
    async set(collection, id, data, options = {}) {
      if (control.failSetConflicts > 0) {
        control.failSetConflicts -= 1;
        throw conflict();
      }
      const collectionRecords = records(collection);
      verifyPrecondition(collectionRecords.get(id), options);
      collectionRecords.set(id, {
        data: structuredClone(data),
        updateTime: nextUpdateTime(),
      });
    },
    async delete(collection, id, options = {}) {
      const collectionRecords = records(collection);
      verifyPrecondition(collectionRecords.get(id), options);
      collectionRecords.delete(id);
    },
    async query(collection, options = {}) {
      return [...records(collection)]
        .filter(([, record]) =>
          (options.filters || []).every((filter) =>
            matches(record.data, filter),
          ),
        )
        .slice(0, options.limit || 200)
        .map(([id, record]) =>
          result(id, record, Boolean(options.includeMetadata)),
        );
    },
    queryEqual(collection, field, value, limit = 200, options = {}) {
      return this.query(collection, {
        filters: [{ field, value }],
        limit,
        includeMetadata: options.includeMetadata,
      });
    },
    async commitOperations(operations) {
      control.commitCalls += 1;
      if (control.alwaysCommitConflict || control.failCommitConflicts > 0) {
        control.failCommitConflicts = Math.max(
          0,
          control.failCommitConflicts - 1,
        );
        throw conflict();
      }
      for (const operation of operations) {
        verifyPrecondition(
          records(operation.collection).get(operation.id),
          operation,
        );
      }
      for (const operation of operations) {
        const collectionRecords = records(operation.collection);
        if (operation.type === "delete") {
          collectionRecords.delete(operation.id);
        } else {
          collectionRecords.set(operation.id, {
            data: structuredClone(operation.data),
            updateTime: nextUpdateTime(),
          });
        }
      }
    },
  };
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Firestore OAuth session stores keep provider state isolated and ordered", async () => {
  const documentStore = createFakeDocumentStore();
  const github = createFirestoreOAuthSessionStore({
    provider: "github",
    env: GCP_ENV,
    documentStore,
  });
  const google = createFirestoreOAuthSessionStore({
    provider: "google",
    env: GCP_ENV,
    documentStore,
  });
  await github.set("github-one", {
    data: "encrypted-a",
    updatedAt: "2026-01-01",
  });
  await github.set("github-two", {
    data: "encrypted-b",
    updatedAt: "2026-02-01",
  });
  await google.set("google-one", {
    data: "encrypted-c",
    updatedAt: "2026-03-01",
  });

  assert.deepEqual(
    (await github.listLatest()).map(({ id }) => id),
    ["github-two", "github-one"],
  );
  assert.deepEqual(
    (await google.listLatest()).map(({ id }) => id),
    ["google-one"],
  );
  assert.equal(await github.get("google-one"), null);
});

test("GitHub and Google sessions persist encrypted through Firestore", async () => {
  const documentStore = createFakeDocumentStore();
  const githubStore = createFirestoreOAuthSessionStore({
    provider: "github",
    env: GCP_ENV,
    documentStore,
  });
  const googleStore = createFirestoreOAuthSessionStore({
    provider: "google",
    env: GCP_ENV,
    documentStore,
  });

  await withEnvironment(
    {
      ...GCP_ENV,
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      GITHUB_SESSION_ENCRYPTION_KEY: "github-session-key",
      GOOGLE_SESSION_ENCRYPTION_KEY: "google-session-key",
    },
    async () => {
      setFirestoreGitHubSessionStoreForTests(githubStore);
      setFirestoreGoogleSessionStoreForTests(googleStore);
      const githubSession = await createGitHubSession(
        { access_token: "private-github-token" },
        async () =>
          new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
            status: 200,
          }),
      );
      const googleSessionId = await createGoogleSession({
        access_token: "private-google-token",
        refresh_token: "private-google-refresh",
        expires_in: 3600,
      });

      assert.doesNotMatch(
        JSON.stringify([...documentStore.collections]),
        /private-github-token|private-google-token|private-google-refresh/u,
      );

      resetGitHubSessionsForTests();
      resetGoogleSessionsForTests();
      setFirestoreGitHubSessionStoreForTests(githubStore);
      setFirestoreGoogleSessionStoreForTests(googleStore);
      assert.equal(
        (await getGitHubSession(githubSession.id)).accessToken,
        "private-github-token",
      );
      assert.equal(await hasGoogleSession(googleSessionId), true);
    },
  );
  resetGitHubSessionsForTests();
  resetGoogleSessionsForTests();
});

test("Firestore MCP store retries version conflicts and verifies revocation", async () => {
  const documentStore = createFakeDocumentStore();
  const store = createFirestoreMcpOAuthStore({
    env: GCP_ENV,
    documentStore,
  });
  const grant = {
    grantId: "grant-one",
    subject: "owner-one",
    memoryOwnerId: "primary-user",
    role: "owner",
    clientId: "client-one",
    scopes: [MCP_READ_SCOPE],
    issuedAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-09-10T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };
  await store.createGrant(grant.grantId, grant);
  documentStore.control.failSetConflicts = 1;
  const mutation = await store.mutateGrant(grant.grantId, (current) => ({
    ...current,
    lastUsedAt: "2026-08-10T01:00:00.000Z",
  }));
  assert.equal(mutation.updated, true);

  documentStore.control.failCommitConflicts = 1;
  assert.equal(
    await store.revokeGrants({
      subject: grant.subject,
      revokedAt: "2026-08-10T02:00:00.000Z",
    }),
    1,
  );
  assert.equal(documentStore.control.commitCalls, 2);
  assert.equal(
    (await store.getGrant(grant.grantId)).data.revokedAt,
    "2026-08-10T02:00:00.000Z",
  );
});

test("Firestore MCP store fails closed when revoke conflicts remain", async () => {
  const documentStore = createFakeDocumentStore();
  const store = createFirestoreMcpOAuthStore({
    env: GCP_ENV,
    documentStore,
  });
  await store.createGrant("grant-one", {
    subject: "owner-one",
    revokedAt: null,
  });
  documentStore.control.alwaysCommitConflict = true;

  await assert.rejects(
    () =>
      store.revokeGrants({
        subject: "owner-one",
        revokedAt: "2026-08-10T02:00:00.000Z",
      }),
    (error) => error.code === "MCP_OAUTH_WRITE_CONFLICT",
  );
  assert.equal(documentStore.control.commitCalls, 3);
});

test("MCP authorization, refresh, replay and revoke use Firestore only", async () => {
  resetMcpOAuthStateForTests();
  const documentStore = createFakeDocumentStore();
  const firestoreStore = createFirestoreMcpOAuthStore({
    env: GCP_ENV,
    documentStore,
  });
  const env = {
    ...GCP_ENV,
    NODE_ENV: "production",
    MCP_ACCESS_TOKEN: "mcp-firestore-test-secret-with-more-than-32-characters",
    MCP_RESOURCE_URL: "https://cloudaicore.com/mcp",
  };
  const clientId = "https://chatgpt.com/oauth/firestore/client.json";
  const redirectUri = "https://chatgpt.com/connector/oauth/firestore";
  const verifier = "v".repeat(64);
  const request = {
    clientId,
    redirectUri,
    resource: env.MCP_RESOURCE_URL,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    scopes: [MCP_READ_SCOPE],
  };
  const code = createMcpAuthorizationCode(
    request,
    { id: "owner-one", memoryOwnerId: "primary-user", role: "owner" },
    env,
  );
  const tokens = await exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: env.MCP_RESOURCE_URL,
    },
    env,
    { client: null, firestoreStore },
  );
  const identity = verifyMcpAccessToken(
    `Bearer ${tokens.access_token}`,
    [MCP_READ_SCOPE],
    env,
  );
  assert.equal(
    (
      await listActiveMcpGrants({
        subject: "owner-one",
        env,
        client: null,
        firestoreStore,
      })
    ).length,
    1,
  );

  const refreshInput = {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource: env.MCP_RESOURCE_URL,
  };
  documentStore.control.failSetConflicts = 3;
  await assert.rejects(
    exchangeMcpRefreshToken(refreshInput, env, {
      client: null,
      firestoreStore,
    }),
    (error) => error.code === "temporarily_unavailable",
  );
  const refreshed = await exchangeMcpRefreshToken(refreshInput, env, {
    client: null,
    firestoreStore,
  });
  assert.ok(refreshed.access_token);
  assert.equal(
    await revokeMcpGrants({
      subject: "owner-one",
      grantId: identity.grantId,
      env,
      client: null,
      firestoreStore,
    }),
    1,
  );
  await assert.rejects(
    assertMcpGrantActive(identity, {
      env,
      client: null,
      firestoreStore,
    }),
    (error) => error.code === "invalid_token",
  );

  const replayInput = {
    grantType: "authorization_code",
    tokenId: "independent-replay-id",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    env,
    client: null,
    firestoreStore,
  };
  assert.equal(await consumeMcpGrantOnce(replayInput), true);
  resetMcpOAuthStateForTests();
  assert.equal(await consumeMcpGrantOnce(replayInput), false);
});

test("MCP replay treats non-duplicate Firestore preconditions as unavailable", async () => {
  resetMcpOAuthStateForTests();
  const env = {
    ...GCP_ENV,
    NODE_ENV: "production",
    MCP_ACCESS_TOKEN: "mcp-firestore-test-secret-with-more-than-32-characters",
  };
  const firestoreStore = {
    async createReplay() {
      throw conflict("FAILED_PRECONDITION");
    },
  };

  await assert.rejects(
    consumeMcpGrantOnce({
      grantType: "authorization_code",
      tokenId: "not-a-duplicate",
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      env,
      client: null,
      firestoreStore,
    }),
    (error) => error.code === "temporarily_unavailable" && error.status === 503,
  );
});

test("MCP replay recovers only its own Firestore commit after a lost response", async () => {
  resetMcpOAuthStateForTests();
  const env = {
    ...GCP_ENV,
    NODE_ENV: "production",
    MCP_ACCESS_TOKEN: "mcp-firestore-test-secret-with-more-than-32-characters",
  };
  let document = null;
  const firestoreStore = {
    async createReplay(id, data) {
      if (document) throw conflict("ALREADY_EXISTS");
      document = { id, data: structuredClone(data) };
      const error = new Error("Response lost after Firestore commit");
      error.upstreamStatus = 503;
      throw error;
    },
    async getReplay(id) {
      return document?.id === id ? structuredClone(document) : null;
    },
    async cleanupExpiredReplay() {
      return 0;
    },
  };
  const input = {
    grantType: "authorization_code",
    tokenId: "ambiguous-firestore-commit",
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    env,
    client: null,
    firestoreStore,
  };

  assert.equal(await consumeMcpGrantOnce(input), true);
  resetMcpOAuthStateForTests();
  assert.equal(await consumeMcpGrantOnce(input), false);
});
