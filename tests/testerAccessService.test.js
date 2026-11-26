import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  approveTesterAccess,
  approveTesterEmail,
  assertPublicAccountAccess,
  assertTesterAccess,
  TesterAccessError,
} from "../src/services/testerAccessService.js";

function createClient() {
  const records = new Map();
  const requestOptions = [];
  return {
    records,
    requestOptions,
    async index({ id, body }, options) {
      requestOptions.push({ operation: "index", options });
      records.set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async get({ id }, options) {
      requestOptions.push({ operation: "get", options });
      if (!records.has(id)) {
        const error = new Error("not found");
        error.statusCode = 404;
        throw error;
      }
      return { body: { _source: structuredClone(records.get(id)) } };
    },
  };
}

const ACCESS_ENV = {
  MCP_ACCESS_TOKEN: "test-access-secret-with-enough-entropy",
};

test("invite-approved registration stores a server-side access record", async () => {
  const client = createClient();
  const approved = await approveTesterAccess(
    { id: "user-approved", email: "friend@example.com" },
    { client },
  );

  assert.equal(approved.userId, "user-approved");
  assert.deepEqual(Object.keys(client.records.get("user-approved")).sort(), [
    "approvedAt",
    "status",
    "userId",
  ]);
  assert.equal(
    await assertTesterAccess({ id: "user-approved" }, { client }),
    true,
  );
  assert.deepEqual(client.requestOptions, [
    {
      operation: "index",
      options: { requestTimeout: 5_000, maxRetries: 0 },
    },
    {
      operation: "get",
      options: { requestTimeout: 5_000, maxRetries: 0 },
    },
  ]);
});

test("approval timeout fails closed with a bounded service error", async () => {
  const client = {
    async index(_request, options) {
      assert.deepEqual(options, { requestTimeout: 5_000, maxRetries: 0 });
      const error = new Error("Request timed out");
      error.name = "TimeoutError";
      throw error;
    },
  };

  await assert.rejects(
    approveTesterAccess({ id: "slow-user" }, { client }),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "TESTER_ACCESS_PERSISTENCE_FAILED" &&
      error.status === 503,
  );
});

test("a direct Supabase signup cannot pass the application access boundary", async () => {
  const client = createClient();

  await assert.rejects(
    assertTesterAccess({ id: "direct-signup" }, { client }),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "TESTER_ACCESS_NOT_APPROVED" &&
      error.status === 403,
  );
});

test("an invite-approved email can recover access without storing a guessable email hash", async () => {
  const client = createClient();
  const approved = await approveTesterEmail(" Friend@Example.com ", {
    client,
    env: ACCESS_ENV,
  });

  assert.equal(approved.emailHash.length, 64);
  assert.equal(
    await assertTesterAccess(
      { id: "recovered-user", email: "friend@example.com" },
      { client, env: ACCESS_ENV },
    ),
    true,
  );
  const stored = [...client.records.values()].find(
    (record) => record.emailHash === approved.emailHash,
  );
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored), /friend@example\.com/iu);
  assert.notEqual(
    approved.emailHash,
    createHash("sha256").update("friend@example.com").digest("hex"),
  );
});

test("the configured primary Supabase owner does not need a tester record", async () => {
  const client = createClient();
  assert.equal(
    await assertTesterAccess(
      { id: "primary-user-id" },
      {
        client,
        env: { SYNCHRON_PRIMARY_SUPABASE_USER_ID: "primary-user-id" },
      },
    ),
    true,
  );
});

test("OpenSearch failures fail closed", async () => {
  const client = {
    async get() {
      throw new Error("cluster unavailable");
    },
  };

  await assert.rejects(
    assertTesterAccess({ id: "user-a" }, { client }),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "TESTER_ACCESS_UNAVAILABLE" &&
      error.status === 503,
  );
});

test("public accounts pass without an access record", async () => {
  const client = createClient();
  assert.equal(
    await assertPublicAccountAccess({ id: "new-public-user" }, { client }),
    true,
  );
});

test("public accounts with an approved record pass", async () => {
  const client = createClient();
  await approveTesterAccess({ id: "approved-public" }, { client });
  assert.equal(
    await assertPublicAccountAccess({ id: "approved-public" }, { client }),
    true,
  );
});

test("public accounts with a revoked record stay blocked", async () => {
  const client = createClient();
  client.records.set("revoked-public", {
    userId: "revoked-public",
    status: "revoked",
  });
  await assert.rejects(
    assertPublicAccountAccess({ id: "revoked-public" }, { client }),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "ACCOUNT_ACCESS_REVOKED" &&
      error.status === 403,
  );
});

test("a storage failure fails closed so a revoked account cannot slip in", async () => {
  const client = {
    async get() {
      throw new Error("cluster unavailable");
    },
  };
  await assert.rejects(
    assertPublicAccountAccess(
      { id: "public-user" },
      { client, logError: () => {} },
    ),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "TESTER_ACCESS_UNAVAILABLE" &&
      error.status === 503,
  );
});

test("a missing storage configuration is not treated as access", async () => {
  await assert.rejects(
    assertPublicAccountAccess(
      { id: "public-user" },
      { env: { USER_AUTH_BACKEND: "", MEMORY_BACKEND: "invalid-backend" } },
    ),
    (error) =>
      error instanceof TesterAccessError &&
      error.code === "TESTER_ACCESS_UNAVAILABLE",
  );
});

test("the primary user passes public access even with a stale record", async () => {
  const client = createClient();
  client.records.set("owner-user", {
    userId: "owner-user",
    status: "revoked",
  });
  assert.equal(
    await assertPublicAccountAccess(
      { id: "owner-user" },
      { client, env: { ...process.env, SYNCHRON_PRIMARY_USER_ID: "owner-user" } },
    ),
    true,
  );
});

test("a Google account linked to the owner is recognised as the owner", async () => {
  const { clearPrimaryOwnerCacheForTests, isPrimaryOwnerAccount, linkPrimaryOwnerAccount } =
    await import("../src/services/testerAccessService.js");
  clearPrimaryOwnerCacheForTests();
  const client = createClient();
  const owner = { id: "google-owner", authProvider: "identity-platform" };
  const stranger = { id: "google-stranger", authProvider: "identity-platform" };

  assert.equal(await isPrimaryOwnerAccount(owner, { client }), false);
  clearPrimaryOwnerCacheForTests();
  await linkPrimaryOwnerAccount(owner, { client });

  const record = client.records.get("primary-owner:identity-platform:google-owner");
  assert.equal(record.userId, "google-owner");
  assert.equal(record.status, "linked");
  assert.equal(await isPrimaryOwnerAccount(owner, { client }), true);
  assert.equal(await isPrimaryOwnerAccount(stranger, { client }), false);
  // A record for the same id from another provider does not count.
  assert.equal(
    await isPrimaryOwnerAccount({ id: "google-owner", authProvider: "supabase" }, { client }),
    false,
  );
});

test("a storage failure never turns a member into the owner", async () => {
  const { clearPrimaryOwnerCacheForTests, isPrimaryOwnerAccount } = await import(
    "../src/services/testerAccessService.js"
  );
  clearPrimaryOwnerCacheForTests();
  const client = {
    async get() {
      const error = new Error("down");
      error.statusCode = 503;
      throw error;
    },
  };
  assert.equal(
    await isPrimaryOwnerAccount(
      { id: "someone", authProvider: "identity-platform" },
      { client, logError: () => {} },
    ),
    false,
  );
});
