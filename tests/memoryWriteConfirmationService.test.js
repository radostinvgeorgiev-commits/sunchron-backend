import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfirmation,
  markConfirmationUsed,
  resetConfirmationsForTests,
  validateConfirmation,
} from "../src/services/confirmationService.js";
import {
  confirmMemoryWrite,
  extractMemoryWriteConfirmationId,
  MEMORY_WRITE_ACTION,
  prepareMemoryWrite,
} from "../src/services/memoryWriteConfirmationService.js";
import {
  executeAuditedWriteAction,
  listAuditEvents,
  recordAuditEvent,
  resetAuditFallbackForTests,
} from "../src/services/permissionService.js";

const executeWithoutAudit = async ({ execute }) => execute();

test.beforeEach(() => {
  resetConfirmationsForTests();
  resetAuditFallbackForTests();
});

test("prepares the exact fact without writing or storing the raw owner id", async () => {
  let created;
  const prepared = await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "private-owner-id",
    items: [{ fact: "  Любимият ми цвят е син.  ", scope: "personal" }],
    createConfirmation: async (input) => {
      created = input;
      return { id: "confirmation-1", expiresAt: Date.now() + 60_000 };
    },
  });

  assert.equal(created.action, MEMORY_WRITE_ACTION);
  assert.equal(created.sessionId, "session-a");
  assert.match(created.resource.ownerFingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(created), /private-owner-id/u);
  assert.deepEqual(created.params.items, [
    { fact: "Любимият ми цвят е син", scope: "personal" },
  ]);
  assert.deepEqual(prepared.items, created.params.items);
});

test("consumes before one write bound to the same owner and exact fact", async () => {
  let storedConfirmation;
  await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ fact: "Живея във Варна", scope: "personal" }],
    createConfirmation: async (input) => {
      storedConfirmation = { ...input, id: "confirmation-1" };
      return storedConfirmation;
    },
  });
  const order = [];

  const items = await confirmMemoryWrite({
    confirmationId: "confirmation-1",
    sessionId: "session-a",
    ownerId: "owner-a",
    validateConfirmation: async (id, sessionId) => {
      order.push(`validate:${id}:${sessionId}`);
      return storedConfirmation;
    },
    consumeConfirmation: async (id) => order.push(`consume:${id}`),
    executeWrite: async (input) => {
      order.push("audit:intent");
      return input.execute();
    },
    saveMemory: async (fact, source, scope, ownerId) => {
      order.push(`save:${ownerId}:${source}`);
      return { id: "memory-1", fact, scope, replaced: false };
    },
  });

  assert.deepEqual(order, [
    "validate:confirmation-1:session-a",
    "consume:confirmation-1",
    "audit:intent",
    "save:owner-a:confirmed-memory-write",
  ]);
  assert.deepEqual(items, [
    {
      id: "memory-1",
      fact: "Живея във Варна",
      scope: "personal",
      replaced: false,
    },
  ]);
});

test("blocks a different profile before consuming or writing", async () => {
  let storedConfirmation;
  await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ fact: "Частен факт" }],
    createConfirmation: async (input) => {
      storedConfirmation = { ...input, id: "confirmation-1" };
      return storedConfirmation;
    },
  });
  let consumed = false;
  let written = false;

  await assert.rejects(
    () =>
      confirmMemoryWrite({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-b",
        validateConfirmation: async () => storedConfirmation,
        consumeConfirmation: async () => {
          consumed = true;
        },
        saveMemory: async () => {
          written = true;
        },
      }),
    (error) => error.code === "MEMORY_OWNER_MISMATCH" && error.status === 403,
  );
  assert.equal(consumed, false);
  assert.equal(written, false);
});

test("blocks a different session and a replay of a consumed confirmation", async () => {
  const prepared = await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ fact: "Еднократен факт" }],
    createConfirmation: async (input) => createConfirmation(input),
  });
  const dependencies = {
    validateConfirmation: async (id, sessionId) =>
      validateConfirmation(id, sessionId),
    consumeConfirmation: async (id) => markConfirmationUsed(id),
    saveMemory: async (fact, _source, scope) => ({
      id: "memory-1",
      fact,
      scope,
      replaced: false,
    }),
    executeWrite: executeWithoutAudit,
  };

  await assert.rejects(
    () =>
      confirmMemoryWrite({
        confirmationId: prepared.confirmationId,
        sessionId: "session-b",
        ownerId: "owner-a",
        ...dependencies,
      }),
    (error) => error.code === "SESSION_MISMATCH" && error.status === 403,
  );
  const first = await confirmMemoryWrite({
    confirmationId: prepared.confirmationId,
    sessionId: "session-a",
    ownerId: "owner-a",
    ...dependencies,
  });
  assert.equal(first.length, 1);
  await assert.rejects(
    () =>
      confirmMemoryWrite({
        confirmationId: prepared.confirmationId,
        sessionId: "session-a",
        ownerId: "owner-a",
        ...dependencies,
      }),
    (error) => error.code === "CONFIRMATION_NOT_FOUND" && error.status === 404,
  );
});

test("durable intent failure consumes once but never calls the memory adapter", async () => {
  let storedConfirmation;
  await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ fact: "Частен факт" }],
    createConfirmation: async (input) => {
      storedConfirmation = { ...input, id: "confirmation-1" };
      return storedConfirmation;
    },
  });
  let consumed = 0;
  let written = 0;

  await assert.rejects(
    () =>
      confirmMemoryWrite({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-a",
        validateConfirmation: async () => storedConfirmation,
        consumeConfirmation: async () => {
          consumed += 1;
        },
        saveMemory: async () => {
          written += 1;
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
  assert.equal(written, 0);
});

test("successful memory write with failed outcome audit is uncertain", async () => {
  let storedConfirmation;
  await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ fact: "Частен факт" }],
    createConfirmation: async (input) => {
      storedConfirmation = { ...input, id: "confirmation-1" };
      return storedConfirmation;
    },
  });
  let auditCalls = 0;

  await assert.rejects(
    () =>
      confirmMemoryWrite({
        confirmationId: "confirmation-1",
        sessionId: "session-a",
        ownerId: "owner-a",
        validateConfirmation: async () => storedConfirmation,
        consumeConfirmation: async () => {},
        saveMemory: async (fact, _source, scope) => ({
          id: "memory-1",
          fact,
          scope,
          replaced: false,
        }),
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
      error.code === "AUDIT_OUTCOME_UNCERTAIN" &&
      error.result?.[0]?.id === "memory-1",
  );
});

test("memory write audit stores one intent/outcome pair without raw private values", async () => {
  let storedConfirmation;
  await prepareMemoryWrite({
    sessionId: "session-a",
    ownerId: "private-owner-id",
    items: [{ fact: "Строго частен факт" }],
    createConfirmation: async (input) => {
      storedConfirmation = { ...input, id: "confirmation-secret" };
      return storedConfirmation;
    },
  });

  await confirmMemoryWrite({
    confirmationId: "confirmation-secret",
    sessionId: "session-a",
    ownerId: "private-owner-id",
    validateConfirmation: async () => storedConfirmation,
    consumeConfirmation: async () => {},
    saveMemory: async (fact, _source, scope) => ({
      id: "memory-1",
      fact,
      scope,
      replaced: false,
    }),
    executeWrite: (input) =>
      executeAuditedWriteAction({ ...input, writeAudit: recordAuditEvent }),
  });

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

test("extracts only the dedicated confirmation phrase", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    extractMemoryWriteConfirmationId(`Потвърждавам постоянен запис: ${id}`),
    id,
  );
  assert.equal(extractMemoryWriteConfirmationId(`Да ${id}`), null);
  assert.equal(
    extractMemoryWriteConfirmationId(
      "Потвърждавам постоянен запис: това не е идентификатор",
    ),
    null,
  );
});
