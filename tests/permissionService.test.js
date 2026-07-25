import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePermission,
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
