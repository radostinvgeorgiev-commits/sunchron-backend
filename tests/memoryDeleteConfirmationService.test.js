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

test.beforeEach(() => resetConfirmationsForTests());

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
    deleteByFact: async (fact, scope, ownerId) => {
      order.push(`delete:${fact}:${scope}:${ownerId}`);
      return 1;
    },
  });

  assert.deepEqual(order, [
    "validate",
    "consume",
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
