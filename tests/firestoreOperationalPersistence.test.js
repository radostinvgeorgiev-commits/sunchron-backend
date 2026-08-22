import assert from "node:assert/strict";
import test from "node:test";

import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  resetConfirmationsForTests,
  setFirestoreConfirmationStoreForTests,
  validateDurableConfirmation,
} from "../src/services/confirmationService.js";
import {
  listAuditEvents,
  recordDurableAuditEvent,
  resetAuditFallbackForTests,
  setFirestoreAuditStoreForTests,
} from "../src/services/permissionService.js";
import {
  createFirestoreOperationalStore,
} from "../src/services/firestoreOperationalStore.js";

const ENV_NAMES = [
  "PERSISTENCE_BACKEND",
  "NODE_ENV",
  "GITHUB_SESSION_ENCRYPTION_KEY",
];
const ORIGINAL_ENV = Object.freeze(
  Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]])),
);

function createOperationalStoreDouble() {
  const confirmations = new Map();
  const audits = new Map();
  return {
    async saveConfirmation(id, data) {
      confirmations.set(id, structuredClone(data));
    },
    async getConfirmation(id) {
      const data = confirmations.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async deleteConfirmation(id) {
      return confirmations.delete(id);
    },
    async saveAuditEntry(id, data) {
      audits.set(id, structuredClone(data));
    },
    async listAuditEntries(limit) {
      return [...audits.values()]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },
    confirmations,
    audits,
  };
}

test.beforeEach(() => {
  process.env.PERSISTENCE_BACKEND = "firestore";
  process.env.NODE_ENV = "production";
  process.env.GITHUB_SESSION_ENCRYPTION_KEY = "g".repeat(48);
  resetConfirmationsForTests();
  resetAuditFallbackForTests();
});

test.after(() => {
  resetConfirmationsForTests();
  resetAuditFallbackForTests();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Firestore keeps confirmations encrypted, durable and one-time", async () => {
  const store = createOperationalStoreDouble();
  setFirestoreConfirmationStoreForTests(store);
  const created = await createDurableConfirmation({
    sessionId: "session-a",
    action: "memory.delete:profile",
    resource: { ownerId: "owner-a", fact: "точен факт" },
  });

  assert.equal(store.confirmations.size, 1);
  assert.doesNotMatch(
    JSON.stringify(store.confirmations.get(created.id)),
    /session-a|точен факт/u,
  );

  resetConfirmationsForTests();
  setFirestoreConfirmationStoreForTests(store);
  const loaded = await validateDurableConfirmation(created.id, "session-a");
  assert.equal(loaded.id, created.id);
  await markDurableConfirmationUsed(created.id);
  assert.equal(store.confirmations.size, 0);

  resetConfirmationsForTests();
  setFirestoreConfirmationStoreForTests(store);
  await assert.rejects(
    () => validateDurableConfirmation(created.id, "session-a"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("Firestore stores the durable audit without raw confirmation ids", async () => {
  const store = createOperationalStoreDouble();
  setFirestoreAuditStoreForTests(store);
  const confirmationId = "private-confirmation-id";
  const saved = await recordDurableAuditEvent({
    action: "memory.delete",
    capability: "memory.delete",
    outcome: "succeeded",
    ownerId: "owner-a",
    confirmationId,
  });

  const events = await listAuditEvents(10);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, saved.id);
  assert.equal(events[0].confirmationRef.length, 64);
  assert.doesNotMatch(JSON.stringify(events), /private-confirmation-id/u);
});

test("Firestore audit read falls back when the composite index is missing", async () => {
  const calls = [];
  const documentStore = {
    async queryEqual(collection, field, value, limit, options) {
      calls.push({ collection, field, value, limit, options });
      if (options?.orderBy) {
        const error = new Error("missing index");
        error.code = "FIRESTORE_UNAVAILABLE";
        error.upstreamErrorStatus = "FAILED_PRECONDITION";
        throw error;
      }
      return [
        {
          id: "older",
          data: {
            id: "older",
            firestorePartition: "synchron-audit",
            timestamp: "2026-08-23T10:00:00.000Z",
            outcome: "succeeded",
          },
        },
        {
          id: "newer",
          data: {
            id: "newer",
            firestorePartition: "synchron-audit",
            timestamp: "2026-08-23T11:00:00.000Z",
            outcome: "failed",
          },
        },
      ];
    },
  };
  const store = createFirestoreOperationalStore({
    env: {
      GOOGLE_CLOUD_PROJECT: "synchron-project",
      FIRESTORE_DATABASE_ID: "(default)",
      FIRESTORE_AUDIT_COLLECTION: "synchron-action-audit-v1",
    },
    documentStore,
  });

  const entries = await store.listAuditEntries(1);

  assert.deepEqual(entries, [
    {
      id: "newer",
      timestamp: "2026-08-23T11:00:00.000Z",
      outcome: "failed",
    },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.orderBy, {
    field: "timestamp",
    direction: "DESCENDING",
  });
  assert.equal(calls[1].limit, 1_000);
  assert.equal(calls[1].options, undefined);
});
