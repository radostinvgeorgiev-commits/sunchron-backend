import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePermission,
  executeAuditedWriteAction,
  listAuditEvents,
  listPermissions,
  recordAuditEvent,
  resetAuditFallbackForTests,
} from "../src/services/permissionService.js";

test.beforeEach(() => {
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
  delete process.env.OPENSEARCH_HOST;
  delete process.env.OPENSEARCH_PORT;
  resetAuditFallbackForTests();
});

test("allows approved reads and requires confirmation for risky actions", () => {
  assert.equal(evaluatePermission("github.read").decision, "allow");
  assert.equal(evaluatePermission("github.write").decision, "confirm");
  assert.equal(evaluatePermission("payment").decision, "confirm");
});

test("denies unknown actions by default", () => {
  const result = evaluatePermission("unregistered.action");
  assert.equal(result.decision, "deny");
  assert.equal(result.risk, "unknown");
});

test("exposes the permission registry without mutable policy objects", () => {
  const permissions = listPermissions();
  assert.ok(permissions.some((item) => item.action === "memory.delete"));
  assert.ok(permissions.every((item) => item.decision));
});

test("records append-only audit events when OpenSearch is unavailable", async () => {
  const saved = await recordAuditEvent({
    action: "github.read",
    outcome: "succeeded",
    resource: "GET /github/commits",
  });
  const events = await listAuditEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].id, saved.id);
  assert.equal(events[0].decision, "allow");
  assert.equal(events[0].outcome, "succeeded");
});


test("durable write records intent before one adapter call and a final outcome", async () => {
  const events = [];
  let calls = 0;
  const result = await executeAuditedWriteAction({
    action: "calendar.write",
    capability: "calendar.write",
    sessionId: "session-1",
    confirmationId: "confirmation-1",
    resource: "primary-calendar",
    writeAudit: async (event) => events.push(event),
    execute: async () => {
      calls += 1;
      return { id: "event-1" };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.id, "event-1");
  assert.deepEqual(
    events.map(({ phase, outcome }) => ({ phase, outcome })),
    [
      { phase: "intent", outcome: "intent" },
      { phase: "outcome", outcome: "succeeded" },
    ],
  );
  assert.equal(events[0].auditId, events[1].auditId);
});

test("durable write fails closed before the adapter when intent audit fails", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeAuditedWriteAction({
        action: "github.write",
        capability: "code.write",
        sessionId: "session-1",
        confirmationId: "confirmation-1",
        resource: "allowed-repository",
        writeAudit: async () => {
          throw new Error("audit unavailable");
        },
        execute: async () => {
          calls += 1;
        },
      }),
    (error) => error.code === "AUDIT_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});

test("durable write records an adapter failure without hiding its exact code", async () => {
  const events = [];
  const failure = new Error("provider failed");
  failure.code = "PROVIDER_FAILED";

  await assert.rejects(
    () =>
      executeAuditedWriteAction({
        action: "calendar.write",
        sessionId: "session-1",
        confirmationId: "confirmation-1",
        resource: "primary-calendar",
        writeAudit: async (event) => events.push(event),
        execute: async () => {
          throw failure;
        },
      }),
    (error) => error === failure,
  );

  assert.equal(events.at(-1).phase, "outcome");
  assert.equal(events.at(-1).outcome, "failed");
  assert.equal(events.at(-1).details, "PROVIDER_FAILED");
});

test("successful adapter with failed final audit is uncertain, never completed", async () => {
  let auditCall = 0;
  await assert.rejects(
    () =>
      executeAuditedWriteAction({
        action: "calendar.write",
        sessionId: "session-1",
        confirmationId: "confirmation-1",
        resource: "primary-calendar",
        writeAudit: async () => {
          auditCall += 1;
          if (auditCall === 2) throw new Error("outcome unavailable");
        },
        execute: async () => ({ id: "event-1" }),
      }),
    (error) =>
      error.code === "AUDIT_OUTCOME_UNCERTAIN" &&
      error.result?.id === "event-1",
  );
});

test("stored audit fingerprints the confirmation instead of storing it raw", async () => {
  const confirmationId = "confirmation-secret-value";
  await executeAuditedWriteAction({
    action: "github.write",
    capability: "code.write",
    sessionId: "session-1",
    confirmationId,
    resource: "allowed-repository",
    writeAudit: recordAuditEvent,
    execute: async () => ({ ok: true }),
  });

  const events = await listAuditEvents();
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.confirmationRef?.length === 64));
  assert.doesNotMatch(JSON.stringify(events), /confirmation-secret-value/u);
});
