import assert from "node:assert/strict";
import test from "node:test";

import {
  approveTesterAccess,
  assertTesterAccess,
  TesterAccessError,
} from "../src/services/testerAccessService.js";

function createClient() {
  const records = new Map();
  return {
    records,
    async index({ id, body }) {
      records.set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async get({ id }) {
      if (!records.has(id)) {
        const error = new Error("not found");
        error.statusCode = 404;
        throw error;
      }
      return { body: { _source: structuredClone(records.get(id)) } };
    },
  };
}

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
