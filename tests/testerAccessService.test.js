import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  approveTesterAccess,
  approveTesterEmail,
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
