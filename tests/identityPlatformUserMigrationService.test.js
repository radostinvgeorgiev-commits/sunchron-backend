import assert from "node:assert/strict";
import test from "node:test";

import {
  applySupabaseIdentityMigration,
  createIdentityPlatformMigrationClient,
  createPreservedIdentityMap,
  createSupabaseIdentityMigrationPlan,
  normalizeSupabaseUserExport,
} from "../src/services/identityPlatformUserMigrationService.js";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const BCRYPT_HASH = `$2b$10$${"A".repeat(53)}`;

function sourceUser(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "tester@example.com",
    encrypted_password: BCRYPT_HASH,
    email_confirmed_at: "2026-08-01T10:00:00.000Z",
    raw_user_meta_data: { display_name: "Tester" },
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
    last_sign_in_at: "2026-08-03T09:00:00.000Z",
    banned_until: null,
    deleted_at: null,
    ...overrides,
  };
}

function targetUserFromSource(row = sourceUser()) {
  const [user] = normalizeSupabaseUserExport([row], { now: () => NOW });
  return {
    localId: user.localId,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    passwordHash: user.passwordHash,
  };
}

test("Supabase user plan preserves IDs and never returns emails or password hashes", () => {
  const row = sourceUser();
  const plan = createSupabaseIdentityMigrationPlan({
    sourceRows: [row],
    targetUsers: [],
    now: () => NOW,
  });

  assert.equal(plan.sourceUsers, 1);
  assert.equal(plan.usersToImport, 1);
  assert.equal(plan.verifiedEmails, 1);
  assert.equal(plan.sourceIdsPreserved, true);
  assert.equal(plan.hashAlgorithm, "BCRYPT");
  assert.match(
    plan.confirmation,
    /^MIGRATE_SUPABASE_USERS_TO_IDENTITY_PLATFORM:[a-f0-9]{64}$/u,
  );
  assert.doesNotMatch(JSON.stringify(plan), /tester@example|\$2b\$/u);
  assert.deepEqual(createPreservedIdentityMap([row], { now: () => NOW }), {
    [row.id]: row.id,
  });
});

test("Supabase user normalization rejects unsupported hashes and duplicate identities", () => {
  assert.throws(
    () =>
      normalizeSupabaseUserExport(
        [sourceUser({ encrypted_password: "not-bcrypt" })],
        { now: () => NOW },
      ),
    (error) => error.code === "IDENTITY_USER_MIGRATION_HASH_UNSUPPORTED",
  );
  assert.throws(
    () =>
      normalizeSupabaseUserExport(
        [
          sourceUser(),
          sourceUser({ id: "22222222-2222-4222-8222-222222222222" }),
        ],
        { now: () => NOW },
      ),
    (error) => error.code === "IDENTITY_USER_MIGRATION_SOURCE_CONFLICT",
  );
  assert.throws(
    () =>
      normalizeSupabaseUserExport(
        [sourceUser({ email_confirmed_at: "not-a-timestamp" })],
        { now: () => NOW },
      ),
    (error) => error.code === "IDENTITY_USER_MIGRATION_SOURCE_INVALID",
  );
});

test("identity migration plan is stable when target API order changes", () => {
  const first = { localId: "target.a" };
  const second = { localId: "target.b" };
  const left = createSupabaseIdentityMigrationPlan({
    sourceRows: [sourceUser()],
    targetUsers: [first, second],
    now: () => NOW,
  });
  const right = createSupabaseIdentityMigrationPlan({
    sourceRows: [sourceUser()],
    targetUsers: [second, first],
    now: () => NOW,
  });
  assert.equal(left.confirmation, right.confirmation);
});

test("identity migration plan fails closed on an email collision", () => {
  assert.throws(
    () =>
      createSupabaseIdentityMigrationPlan({
        sourceRows: [sourceUser()],
        targetUsers: [
          {
            ...targetUserFromSource(),
            localId: "different-target-id",
          },
        ],
        now: () => NOW,
      }),
    (error) => error.code === "IDENTITY_USER_MIGRATION_TARGET_CONFLICT",
  );
});

test("Identity Platform migration client uses OAuth, BCRYPT and no overwrite", async () => {
  const requests = [];
  let listPage = 0;
  const client = createIdentityPlatformMigrationClient({
    projectId: "handy-boulevard-479120-q9",
    accessTokenProvider: async () => "private-runtime-token",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === "POST") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      listPage += 1;
      return new Response(
        JSON.stringify(
          listPage === 1
            ? {
                users: [{ localId: "existing-one" }],
                nextPageToken: "next-page",
              }
            : { users: [{ localId: "existing-two" }] },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const existing = await client.listUsers();
  assert.equal(existing.length, 2);
  await client.importUsers([targetUserFromSource()]);

  assert.match(requests[0].url, /accounts:batchGet\?maxResults=1000/u);
  assert.match(requests[1].url, /nextPageToken=next-page/u);
  assert.equal(
    requests[2].options.headers.Authorization,
    "Bearer private-runtime-token",
  );
  const body = JSON.parse(requests[2].options.body);
  assert.equal(body.hashAlgorithm, "BCRYPT");
  assert.equal(body.sanityCheck, true);
  assert.equal(body.allowOverwrite, false);
  assert.equal(body.users.length, 1);
});

test("identity migration requires exact confirmation and verifies every imported user", async () => {
  const row = sourceUser();
  const target = targetUserFromSource(row);
  const plan = createSupabaseIdentityMigrationPlan({
    sourceRows: [row],
    targetUsers: [],
    now: () => NOW,
  });
  let imported = [];
  let listCalls = 0;
  const client = {
    async listUsers() {
      listCalls += 1;
      return listCalls === 1 ? [] : imported;
    },
    async importUsers(users) {
      imported = structuredClone(users);
      return {};
    },
  };

  const result = await applySupabaseIdentityMigration({
    sourceRows: [row],
    client,
    confirmation: plan.confirmation,
    now: () => NOW,
  });
  assert.equal(result.mode, "applied");
  assert.equal(result.submittedUsers, 1);
  assert.equal(result.verifiedUsers, 1);
  assert.equal(result.identityMapEntries, 1);
  assert.deepEqual(imported[0], {
    ...target,
    createdAt: String(Date.parse(row.created_at)),
    lastLoginAt: String(Date.parse(row.last_sign_in_at)),
    passwordUpdatedAt: Date.parse(row.updated_at),
  });
});

test("identity migration writes nothing with a wrong confirmation", async () => {
  let importCalls = 0;
  const client = {
    async listUsers() {
      return [];
    },
    async importUsers() {
      importCalls += 1;
    },
  };
  await assert.rejects(
    () =>
      applySupabaseIdentityMigration({
        sourceRows: [sourceUser()],
        client,
        confirmation: "wrong",
        now: () => NOW,
      }),
    (error) => error.code === "IDENTITY_USER_MIGRATION_CONFIRMATION_REQUIRED",
  );
  assert.equal(importCalls, 0);
});

test("identity migration fails when post-import password verification is incomplete", async () => {
  const row = sourceUser();
  const plan = createSupabaseIdentityMigrationPlan({
    sourceRows: [row],
    targetUsers: [],
    now: () => NOW,
  });
  let listCalls = 0;
  const client = {
    async listUsers() {
      listCalls += 1;
      return listCalls === 1
        ? []
        : [{ ...targetUserFromSource(row), passwordHash: "" }];
    },
    async importUsers() {
      return {};
    },
  };
  await assert.rejects(
    () =>
      applySupabaseIdentityMigration({
        sourceRows: [row],
        client,
        confirmation: plan.confirmation,
        now: () => NOW,
      }),
    (error) => error.code === "IDENTITY_USER_MIGRATION_VERIFICATION_FAILED",
  );
});
