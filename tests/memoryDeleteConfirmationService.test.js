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
  MemoryDeleteConfirmationError,
  prepareMemoryDelete,
} from "../src/services/memoryDeleteConfirmationService.js";

test.beforeEach(() => resetConfirmationsForTests());

test("prepares a narrow delete without storing the raw owner id", async () => {
  let captured;
  const prepared = await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "private-owner-a",
    target: { kind: "fact", fact: "Любим цвят: син.", scope: "personal" },
    createConfirmation: async (input) => {
      captured = input;
      return createConfirmation(input);
    },
  });

  assert.equal(captured.action, MEMORY_DELETE_ACTION);
  assert.equal(captured.resource.kind, "fact");
  assert.doesNotMatch(JSON.stringify(captured.resource), /private-owner-a/u);
  assert.deepEqual(captured.params.target, {
    kind: "fact",
    fact: "Любим цвят: син",
    scope: "personal",
  });
  assert.equal(prepared.target.fact, "Любим цвят: син");
});

test("consumes before deleting the exact stored fact and blocks replay", async () => {
  const prepared = await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "fact", fact: "Точният факт", scope: "project" },
    createConfirmation: createConfirmation,
  });
  const calls = [];
  const options = {
    confirmationId: prepared.confirmationId,
    sessionId: "session-a",
    ownerId: "owner-a",
    validateConfirmation,
    consumeConfirmation: async (id) => {
      markConfirmationUsed(id);
      calls.push("consumed");
    },
    deleteByFact: async (fact, scope, ownerId) => {
      calls.push({ fact, scope, ownerId });
      return 1;
    },
  };

  const result = await confirmMemoryDelete(options);
  assert.deepEqual(calls, [
    "consumed",
    { fact: "Точният факт", scope: "project", ownerId: "owner-a" },
  ]);
  assert.equal(result.deleted, 1);

  await assert.rejects(
    confirmMemoryDelete(options),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("blocks another owner, session, or route target before delete", async () => {
  const prepared = await prepareMemoryDelete({
    sessionId: "session-a",
    ownerId: "owner-a",
    target: { kind: "id", id: "memory-1" },
    createConfirmation: createConfirmation,
  });
  let deleted = false;
  const base = {
    confirmationId: prepared.confirmationId,
    validateConfirmation,
    consumeConfirmation: markConfirmationUsed,
    deleteById: async () => {
      deleted = true;
      return true;
    },
  };

  await assert.rejects(
    confirmMemoryDelete({
      ...base,
      sessionId: "session-b",
      ownerId: "owner-a",
    }),
    (error) => error.code === "SESSION_MISMATCH",
  );
  await assert.rejects(
    confirmMemoryDelete({
      ...base,
      sessionId: "session-a",
      ownerId: "owner-b",
    }),
    (error) => error.code === "MEMORY_DELETE_TARGET_MISMATCH",
  );
  await assert.rejects(
    confirmMemoryDelete({
      ...base,
      sessionId: "session-a",
      ownerId: "owner-a",
      expectedTarget: { kind: "id", id: "memory-2" },
    }),
    (error) => error.code === "MEMORY_DELETE_TARGET_MISMATCH",
  );
  assert.equal(deleted, false);
});

test("accepts only the exact UUID confirmation phrase", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    extractMemoryDeleteConfirmationId(
      `Потвърждавам изтриване от постоянната памет: ${id}`,
    ),
    id,
  );
  assert.equal(extractMemoryDeleteConfirmationId(`Да ${id}`), null);
  assert.equal(
    extractMemoryDeleteConfirmationId(
      "Потвърждавам изтриването от постоянната памет само на факта: нещо",
    ),
    null,
  );
});

test("binds a bulk delete to its exact scope", async () => {
  const prepared = await prepareMemoryDelete({
    sessionId: "session-all",
    ownerId: "owner-a",
    target: { kind: "all", scope: "project" },
    createConfirmation,
  });
  const calls = [];
  const result = await confirmMemoryDelete({
    confirmationId: prepared.confirmationId,
    sessionId: "session-all",
    ownerId: "owner-a",
    expectedTarget: { kind: "all", scope: "project" },
    validateConfirmation,
    consumeConfirmation: async (id) => {
      markConfirmationUsed(id);
      calls.push("consumed");
    },
    clearAll: async (scope, ownerId) => {
      calls.push({ scope, ownerId });
      return 3;
    },
  });
  assert.deepEqual(calls, [
    "consumed",
    { scope: "project", ownerId: "owner-a" },
  ]);
  assert.equal(result.deleted, 3);
});

test("preserves typed target errors", async () => {
  await assert.rejects(
    prepareMemoryDelete({
      sessionId: "session-a",
      ownerId: "owner-a",
      target: { kind: "all", scope: "unknown" },
      createConfirmation,
    }),
    (error) =>
      error instanceof MemoryDeleteConfirmationError &&
      error.code === "MEMORY_DELETE_TARGET_INVALID",
  );
});
