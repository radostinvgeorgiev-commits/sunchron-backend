import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  applyOpenSearchToFirestoreMigration,
  createOpenSearchMigrationInventory,
  createOpenSearchToFirestorePlan,
  normalizeMigrationIdentityMap,
  resolveGcpMigrationDatasets,
  transformGcpMigrationDocument,
} from "../src/services/gcpDataMigrationService.js";
import { profileMemoryDocumentId } from "../src/services/memoryService.js";
import { workspaceDocumentId } from "../src/services/workspaceStateService.js";

function fakeOpenSearch(documentsByIndex) {
  const calls = { search: 0, clearScroll: 0 };
  return {
    calls,
    indices: {
      async exists({ index }) {
        return { body: Object.hasOwn(documentsByIndex, index) };
      },
    },
    async count({ index }) {
      return { body: { count: documentsByIndex[index]?.length || 0 } };
    },
    async search({ index }) {
      calls.search += 1;
      return {
        body: {
          _scroll_id: `scroll-${index}`,
          hits: { hits: structuredClone(documentsByIndex[index] || []) },
        },
      };
    },
    async scroll() {
      return { body: { hits: { hits: [] } } };
    },
    async clearScroll() {
      calls.clearScroll += 1;
      return { body: { succeeded: true } };
    },
  };
}

function taskOwnerHash(ownerId) {
  return createHash("sha256")
    .update("synchron-task-owner-v1\0")
    .update(ownerId)
    .digest("hex");
}

test("migration inventory reports only safe index and count metadata", async () => {
  const datasets = [
    {
      id: "profile",
      sourceIndex: "profile-source",
      targetCollection: "profile-target",
      transform: "copy",
    },
    {
      id: "missing",
      sourceIndex: "missing-source",
      targetCollection: "missing-target",
      transform: "copy",
    },
  ];
  const result = await createOpenSearchMigrationInventory({
    client: fakeOpenSearch({
      "profile-source": [
        { _id: "one", _source: { privateFact: "never-returned" } },
      ],
    }),
    datasets,
  });

  assert.equal(result.totalDocuments, 1);
  assert.deepEqual(result.datasets, [
    {
      id: "profile",
      sourceIndex: "profile-source",
      targetCollection: "profile-target",
      exists: true,
      count: 1,
    },
    {
      id: "missing",
      sourceIndex: "missing-source",
      targetCollection: "missing-target",
      exists: false,
      count: 0,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /never-returned/u);
});

test("migration transforms Supabase-owned documents into the Identity Platform namespace", () => {
  const identityMap = normalizeMigrationIdentityMap({
    "old-user": "new-user",
  });
  const sourceOwner = "supabase:old-user";
  const targetOwner = "identity-platform:new-user";

  const profile = transformGcpMigrationDocument(
    { transform: "profile" },
    {
      _id: "old-profile-id",
      _source: {
        ownerId: sourceOwner,
        memoryKey: "preferred-name",
        fact: "Радко",
      },
    },
    identityMap,
  );
  assert.equal(
    profile.targetId,
    profileMemoryDocumentId(targetOwner, "preferred-name"),
  );
  assert.equal(profile.targetData.ownerId, targetOwner);

  const workspace = transformGcpMigrationDocument(
    { transform: "workspace" },
    {
      _id: workspaceDocumentId(sourceOwner),
      _source: {
        ownerHash: workspaceDocumentId(sourceOwner),
        state: { version: 3 },
      },
    },
    identityMap,
  );
  assert.equal(workspace.targetId, workspaceDocumentId(targetOwner));
  assert.equal(
    workspace.targetData.ownerHash,
    workspaceDocumentId(targetOwner),
  );

  const task = transformGcpMigrationDocument(
    { transform: "task" },
    {
      _id: "task-one",
      _source: { ownerHash: taskOwnerHash(sourceOwner), title: "Тест" },
    },
    identityMap,
  );
  assert.equal(task.targetData.ownerHash, taskOwnerHash(targetOwner));

  const access = transformGcpMigrationDocument(
    { transform: "tester-access" },
    {
      _id: "old-user",
      _source: { userId: "old-user", status: "approved" },
    },
    identityMap,
  );
  assert.equal(access.targetId, "identity-platform:new-user");
  assert.deepEqual(access.targetData, {
    userId: "new-user",
    status: "approved",
    authProvider: "identity-platform",
  });
});

test("migration fails closed when a Supabase owner has no Identity Platform mapping", () => {
  assert.throws(
    () =>
      transformGcpMigrationDocument(
        { transform: "profile" },
        {
          _id: "old-profile-id",
          _source: {
            ownerId: "supabase:unmapped-user",
            memoryKey: "preferred-name",
            fact: "private",
          },
        },
        normalizeMigrationIdentityMap({}),
      ),
    (error) => error.code === "GCP_DATA_MIGRATION_IDENTITY_MAPPING_REQUIRED",
  );
});

test("migration derives the current profile key for legacy memory documents", () => {
  const targetOwner = "identity-platform:new-user";
  const transformed = transformGcpMigrationDocument(
    { transform: "profile" },
    {
      _id: "legacy-profile-id",
      _source: {
        ownerId: "supabase:old-user",
        fact: "Живея в София",
        normalizedFact: "живея в софия",
        source: "legacy",
      },
    },
    normalizeMigrationIdentityMap({ "old-user": "new-user" }),
  );

  assert.equal(
    transformed.targetId,
    profileMemoryDocumentId(targetOwner, "personal:location:residence"),
  );
  assert.deepEqual(transformed.targetData, {
    ownerId: targetOwner,
    fact: "Живея в София",
    normalizedFact: "живея в софия",
    source: "legacy",
    memoryKey: "personal:location:residence",
    category: "location",
    scope: "personal",
  });
});

test("migration converts legacy MCP replay ISO expiry to epoch seconds", () => {
  const transformed = transformGcpMigrationDocument(
    { transform: "mcp-replay" },
    {
      _id: "replay-one",
      _source: {
        grantType: "authorization_code",
        expiresAt: "2026-08-10T12:34:56.000Z",
      },
    },
  );

  assert.equal(
    transformed.targetData.expiresAtEpoch,
    Date.parse("2026-08-10T12:34:56.000Z") / 1_000,
  );
  assert.throws(
    () =>
      transformGcpMigrationDocument(
        { transform: "mcp-replay" },
        {
          _id: "replay-invalid",
          _source: {
            grantType: "refresh_token",
            expiresAt: "not-a-date",
          },
        },
      ),
    (error) => error.code === "GCP_DATA_MIGRATION_SOURCE_INVALID",
  );
});

test("migration adds required Firestore markers and skips unsafe session-bound records", () => {
  const audit = transformGcpMigrationDocument(
    { transform: "audit" },
    { _id: "audit-one", _source: { status: "success" } },
  );
  assert.equal(audit.targetData.firestorePartition, "synchron-audit");

  const github = transformGcpMigrationDocument(
    { transform: "github-oauth" },
    { _id: "session-one", _source: { login: "owner" } },
  );
  assert.equal(github.targetData.firestoreProvider, "github");

  const google = transformGcpMigrationDocument(
    { transform: "google-oauth" },
    { _id: "session-two", _source: { email: "masked" } },
  );
  assert.equal(google.targetData.firestoreProvider, "google");

  const confirmation = transformGcpMigrationDocument(
    { transform: "pending-confirmation" },
    { _id: "confirmation-one", _source: { status: "pending" } },
  );
  assert.equal(
    confirmation.skipReason,
    "pending-confirmations-are-session-bound",
  );
  assert.equal(confirmation.targetData, null);

  const emailApproval = transformGcpMigrationDocument(
    { transform: "tester-access" },
    {
      _id: `email:${"a".repeat(64)}`,
      _source: { status: "approved", emailHash: "private" },
    },
  );
  assert.equal(emailApproval.skipReason, "email-approval-hash-is-secret-bound");
});

test("migration plan is deterministic and apply requires its exact confirmation", async () => {
  const datasets = [
    {
      id: "copy",
      sourceIndex: "source-index",
      targetCollection: "target-collection",
      transform: "copy",
    },
  ];
  const client = fakeOpenSearch({
    "source-index": [
      { _id: "one", _source: { value: 1 } },
      { _id: "two", _source: { value: 2 } },
    ],
  });
  const plan = await createOpenSearchToFirestorePlan({ client, datasets });
  assert.equal(plan.sourceDocuments, 2);
  assert.equal(plan.writableDocuments, 2);
  assert.match(
    plan.confirmation,
    /^MIGRATE_OPENSEARCH_TO_FIRESTORE:[a-f0-9]{64}$/u,
  );
  assert.doesNotMatch(JSON.stringify(plan), /"value"/u);

  const stored = new Map();
  const documentStore = {
    async commitOperations(operations) {
      for (const operation of operations) {
        stored.set(
          `${operation.collection}/${operation.id}`,
          structuredClone(operation.data),
        );
      }
    },
    async get(collection, id) {
      const data = stored.get(`${collection}/${id}`);
      return data ? { id, data: structuredClone(data) } : null;
    },
  };
  await assert.rejects(
    () =>
      applyOpenSearchToFirestoreMigration({
        client,
        documentStore,
        datasets,
        confirmation: "wrong",
      }),
    (error) => error.code === "GCP_DATA_MIGRATION_CONFIRMATION_REQUIRED",
  );
  assert.equal(stored.size, 0);

  const applied = await applyOpenSearchToFirestoreMigration({
    client,
    documentStore,
    datasets,
    confirmation: plan.confirmation,
  });
  assert.equal(applied.mode, "applied");
  assert.equal(applied.writtenDocuments, 2);
  assert.equal(applied.verifiedDocuments, 2);
  assert.equal(stored.size, 2);
});

test("migration writes nothing when the source changes after confirmation", async () => {
  const datasets = [
    {
      id: "copy",
      sourceIndex: "source-index",
      targetCollection: "target-collection",
      transform: "copy",
    },
  ];
  let searchCount = 0;
  const client = {
    indices: {
      async exists() {
        return { body: true };
      },
    },
    async search() {
      searchCount += 1;
      const value = searchCount < 3 ? 1 : 2;
      return {
        body: {
          _scroll_id: `scroll-${searchCount}`,
          hits: { hits: [{ _id: "one", _source: { value } }] },
        },
      };
    },
    async clearScroll() {
      return { body: { succeeded: true } };
    },
  };
  const plan = await createOpenSearchToFirestorePlan({ client, datasets });
  let commitCalls = 0;
  const documentStore = {
    async commitOperations() {
      commitCalls += 1;
    },
    async get() {
      return null;
    },
  };

  await assert.rejects(
    () =>
      applyOpenSearchToFirestoreMigration({
        client,
        documentStore,
        datasets,
        confirmation: plan.confirmation,
      }),
    (error) => error.code === "GCP_DATA_MIGRATION_SOURCE_CHANGED",
  );
  assert.equal(commitCalls, 0);
});

test("default migration mapping covers every persistent runtime store", () => {
  const datasets = resolveGcpMigrationDatasets({});
  assert.deepEqual(
    datasets.map(({ id }) => id),
    [
      "profile-memory",
      "conversation-memory",
      "confirmations",
      "audit",
      "tester-access",
      "workspace",
      "tasks",
      "github-oauth",
      "google-oauth",
      "mcp-grants",
      "mcp-replay",
    ],
  );
});
