import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfirmation,
  markConfirmationUsed,
  resetConfirmationsForTests,
  validateConfirmation,
} from "../src/services/confirmationService.js";
import {
  confirmMemoryDelete,
  extractMemoryDeleteConfirmationId,
  MEMORY_DELETE_ACTION,
  prepareMemoryDelete,
} from "../src/services/memoryDeleteConfirmationService.js";
import {
  executeAuditedWriteAction,
  listAuditEvents,
  recordAuditEvent,
  resetAuditFallbackForTests,
  setFirestoreAuditStoreForTests,
} from "../src/services/permissionService.js";

function auditStoreDouble() {
  const entries = new Map();
  return {
    entries,
    async saveAuditEntry(id, data) {
      entries.set(id, structuredClone(data));
    },
    async listAuditEntries(limit = 100) {
      return [...entries.values()].slice(-limit).reverse().map((entry) => structuredClone(entry));
    },
  };
}

test.beforeEach(() => {
  process.env.PERSISTENCE_BACKEND = "firestore";
  process.env.GOOGLE_CLOUD_PROJECT = "handy-boulevard-479120-q9";
  resetConfirmationsForTests();
  resetAuditFallbackForTests();
  setFirestoreAuditStoreForTests(auditStoreDouble());
});

const executeWithoutAudit = async ({ execute }) => execute();

test("prepares an exact fact without storing the raw owner id", async () => {
  let created;
  const prepared = await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "private-owner-id",
    target: { kind: "fact", fact: "  Живея във Варна. ", scope: "personal" },
    createConfirmation: async (input) => {
      created = input;
      return { id: "confirmation-1", expiresAt: Date.now() + 60_000 };
    },
  });

  assert.equal(created.action, MEMORY_DELETE_ACTION);
  assert.equal(created.sessionId, "session-a");
  assert.match(created.resource.ownerFingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(created), /private-owner-id/u);
  assert.deepEqual(created.params.target, {
    kind: "fact",
    fact: "Живея във Варна",
    scope: "personal",
  });
  assert.deepEqual(prepared.target, created.params.target);
});

test("consumes before deleting the exact target", async () => {
  let stored;
  await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "fact", fact: "Точен факт", scope: "project" },
    createConfirmation: async (input) => {
      stored = { ...input, id: "confirmation-1" };
      return stored;
    },
  });
  const order = [];
  const result = await confirmMemoryDelete({
    confirmationId: "confirmation-1",
    sessionId: "session-a",
    ownerId: "owner-a",
    expectedTarget: { kind: "fact", fact: "Точен факт", scope: "project" },
    validateConfirmation: async () => {
      order.push("validate");
      return stored;
    },
    consumeConfirmation: async () => order.push("consume"),
    executeWrite: async (input) => {
      order.push("audit:intent");
      return input.execute();
    },
    deleteByFact: async (fact, scope, ownerId) => {
      order.push(`delete:${fact}:${scope}:${ownerId}`);
      return 1;
    },
  });

  assert.deepEqual(order, [
    "validate",
    "consume",
    "audit:intent",
    "delete:Точен факт:project:owner-a",
  ]);
  assert.equal(result.deleted, 1);
});

test("blocks owner and target mismatch before consuming", async () => {
  let stored;
  await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "id", id: "memory-1" },
    createConfirmation: async (input) => {
      stored = { ...input, id: "confirmation-1" };
      return stored;
    },
  });
  let consumed = false;
  let deleted = false;
  const dependencies = {
    validateConfirmation: async () => stored,
    consumeConfirmation: async () => {
      consumed = true;
    },
    deleteById: async () => {
      deleted = true;
      return 1;
    },
  };

  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-b",
        expectedTarget: { kind: "id", id: "memory-1" },
        ...dependencies,
      }),
    (error) => error.code === "MEMORY_OWNER_MISMATCH" && error.status === 403,
  );
  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-a",
        expectedTarget: { kind: "id", id: "memory-2" },
        ...dependencies,
      }),
    (error) =>
      error.code === "MEMORY_DELETE_TARGET_MISMATCH" && error.status === 403,
  );
  assert.equal(consumed, false);
  assert.equal(deleted, false);
});

test("blocks a different session and replay", async () => {
  const prepared = await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "all", scope: "personal" },
    createConfirmation: async (input) => createConfirmation(input),
  });
  const dependencies = {
    validateConfirmation: async (id, sessionId) =>
      validateConfirmation(id, sessionId),
    consumeConfirmation: async (id) => markConfirmationUsed(id),
    deleteAll: async () => 2,
    executeWrite: executeWithoutAudit,
  };

  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: prepared.confirmationId,
        sessionId: "session-b",
        ownerId: "owner-a",
        ...dependencies,
      }),
    (error) => error.code === "SESSION_MISMATCH" && error.status === 403,
  );
  const first = await confirmMemoryDelete({
    confirmationId: prepared.confirmationId,
    sessionId: "session-a",
    ownerId: "owner-a",
    ...dependencies,
  });
  assert.equal(first.deleted, 2);
  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: prepared.confirmationId,
        sessionId: "session-a",
        ownerId: "owner-a",
        ...dependencies,
      }),
    (error) => error.code === "CONFIRMATION_NOT_FOUND" && error.status === 404,
  );
});

test("durable intent failure consumes once but never calls the delete adapter", async () => {
  let stored;
  await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "all", scope: "personal" },
    createConfirmation: async (input) => {
      stored = { ...input, id: "confirmation-1" };
      return stored;
    },
  });
  let consumed = 0;
  let deleted = 0;

  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-a",
        validateConfirmation: async () => stored,
        consumeConfirmation: async () => {
          consumed += 1;
        },
        deleteAll: async () => {
          deleted += 1;
        },
        executeWrite: (input) =>
          executeAuditedWriteAction({
            ...input,
            writeAudit: async () => {
              throw new Error("audit unavailable");
            },
          }),
      }),
    (error) => error.code === "AUDIT_UNAVAILABLE" && error.status === 503,
  );

  assert.equal(consumed, 1);
  assert.equal(deleted, 0);
});

test("successful memory delete with failed outcome audit is uncertain", async () => {
  let stored;
  await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "all", scope: "personal" },
    createConfirmation: async (input) => {
      stored = { ...input, id: "confirmation-1" };
      return stored;
    },
  });
  let auditCalls = 0;

  await assert.rejects(
    () =>
      confirmMemoryDelete({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-a",
        validateConfirmation: async () => stored,
        consumeConfirmation: async () => {},
        deleteAll: async () => 2,
        executeWrite: (input) =>
          executeAuditedWriteAction({
            ...input,
            writeAudit: async () => {
              auditCalls += 1;
              if (auditCalls === 2) throw new Error("outcome unavailable");
            },
          }),
      }),
    (error) =>
      error.code === "AUDIT_OUTCOME_UNCERTAIN" && error.result?.deleted === 2,
  );
});

test("memory delete audit stores one intent/outcome pair without raw private values", async () => {
  let stored;
  await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "private-owner-id",
    target: {
      kind: "fact",
      fact: "Строго частен факт",
      scope: "personal",
    },
    createConfirmation: async (input) => {
      stored = { ...input, id: "confirmation-secret" };
      return stored;
    },
  });

  const result = await confirmMemoryDelete({
    confirmationId: "confirmation-secret",
    sessionId: "session-a",
    ownerId: "private-owner-id",
    validateConfirmation: async () => stored,
    consumeConfirmation: async () => {},
    deleteByFact: async () => 1,
    executeWrite: (input) =>
      executeAuditedWriteAction({ ...input, writeAudit: recordAuditEvent }),
  });

  assert.equal(result.deleted, 1);
  const events = await listAuditEvents();
  assert.deepEqual(
    events.map(({ phase, outcome }) => ({ phase, outcome })).reverse(),
    [
      { phase: "intent", outcome: "intent" },
      { phase: "outcome", outcome: "succeeded" },
    ],
  );
  assert.equal(events[0].auditId, events[1].auditId);
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-owner-id|Строго частен факт|confirmation-secret/u,
  );
});

test("extracts only the dedicated UUID confirmation phrase", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    extractMemoryDeleteConfirmationId(
      `Потвърждавам изтриването от постоянната памет: ${id}`,
    ),
    id,
  );
  assert.equal(extractMemoryDeleteConfirmationId(`Да ${id}`), null);
  assert.equal(
    extractMemoryDeleteConfirmationId(
      "Потвърждавам изтриването от постоянната памет само на факта: текст",
    ),
    null,
  );
});
