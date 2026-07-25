import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfirmation,
  denyConfirmation,
  isAllowedAction,
  listAllowedActions,
  markConfirmationUsed,
  resetConfirmationsForTests,
  validateConfirmation,
} from "../src/services/confirmationService.js";

const VALID_ACTION = "github.write:create_file";
const VALID_RESOURCE = { repository: "owner/repo", branch: "main", path: "hello.txt" };

test.beforeEach(() => {
  resetConfirmationsForTests();
});

// ─── isAllowedAction ──────────────────────────────────────────────────────────

test("recognises all declared write actions as allowed", () => {
  for (const action of listAllowedActions()) {
    assert.equal(isAllowedAction(action), true, `expected "${action}" to be allowed`);
  }
});

test("rejects unknown actions", () => {
  assert.equal(isAllowedAction("github.write:delete_everything"), false);
  assert.equal(isAllowedAction("unknown"), false);
  assert.equal(isAllowedAction(""), false);
});

// ─── createConfirmation ───────────────────────────────────────────────────────

test("creates a confirmation with correct structure", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    params: { content: "hello", message: "Add hello.txt" },
  });

  assert.ok(typeof conf.id === "string" && conf.id.length > 0, "id must be a non-empty string");
  assert.equal(conf.sessionId, "sess-1");
  assert.equal(conf.action, VALID_ACTION);
  assert.deepEqual(conf.resource, VALID_RESOURCE);
  assert.equal(conf.params.content, "hello");
  assert.ok(conf.expiresAt > Date.now(), "expiresAt must be in the future");
});

test("blocks unknown actions — default deny", () => {
  assert.throws(
    () =>
      createConfirmation({
        sessionId: "sess-1",
        action: "github.write:nuke_repo",
        resource: VALID_RESOURCE,
      }),
    (error) => error.code === "UNKNOWN_ACTION",
  );
});

test("blocks missing or invalid session", () => {
  for (const sessionId of ["", "  ", null, undefined]) {
    assert.throws(
      () =>
        createConfirmation({ sessionId, action: VALID_ACTION, resource: VALID_RESOURCE }),
      (error) => error.code === "MISSING_SESSION",
      `should reject sessionId: ${JSON.stringify(sessionId)}`,
    );
  }
});

test("blocks missing resource", () => {
  assert.throws(
    () => createConfirmation({ sessionId: "sess-1", action: VALID_ACTION, resource: null }),
    (error) => error.code === "MISSING_RESOURCE",
  );
});

test("strips sensitive fields from params before storing", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    params: {
      content: "hello",
      token: "secret-token",
      password: "hunter2",
      apiKey: "key123",
      api_key: "key456",
      authorization: "******",
    },
  });

  assert.equal(conf.params.content, "hello");
  assert.equal(conf.params.token, undefined);
  assert.equal(conf.params.password, undefined);
  assert.equal(conf.params.apiKey, undefined);
  assert.equal(conf.params.api_key, undefined);
  assert.equal(conf.params.authorization, undefined);
});

// ─── validateConfirmation ─────────────────────────────────────────────────────

test("validates a correct confirmation — success path", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
  });

  const validated = validateConfirmation(conf.id, "sess-1");
  assert.equal(validated.id, conf.id);
  assert.equal(validated.action, VALID_ACTION);
});

test("rejects confirmation with wrong session — session mismatch", () => {
  const conf = createConfirmation({
    sessionId: "sess-correct",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
  });

  assert.throws(
    () => validateConfirmation(conf.id, "sess-wrong"),
    (error) => error.code === "SESSION_MISMATCH",
  );
});

test("rejects expired confirmation — CONFIRMATION_EXPIRED", () => {
  // ttlMs: -1000 puts expiresAt in the past
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    ttlMs: -1000,
  });

  assert.throws(
    () => validateConfirmation(conf.id, "sess-1"),
    (error) => error.code === "CONFIRMATION_EXPIRED",
  );
});

test("rejects reuse of a confirmation — CONFIRMATION_NOT_FOUND after mark used", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
  });

  markConfirmationUsed(conf.id);

  assert.throws(
    () => validateConfirmation(conf.id, "sess-1"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("rejects non-existent confirmation id", () => {
  assert.throws(
    () => validateConfirmation("00000000-0000-0000-0000-000000000000", "sess-1"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("one confirmation cannot approve a different action — ids are unique", () => {
  const conf1 = createConfirmation({
    sessionId: "sess-1",
    action: "github.write:create_file",
    resource: { branch: "main", path: "a.txt" },
  });

  const conf2 = createConfirmation({
    sessionId: "sess-1",
    action: "github.write:create_pr",
    resource: { head: "feature", base: "main" },
  });

  // Using conf1's id only approves conf1's action, not conf2's
  const validated = validateConfirmation(conf1.id, "sess-1");
  assert.equal(validated.action, "github.write:create_file");
  assert.notEqual(conf1.id, conf2.id);
});

// ─── denyConfirmation ─────────────────────────────────────────────────────────

test("denies a pending confirmation — removes it from store", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
  });

  const denied = denyConfirmation(conf.id, "sess-1");
  assert.equal(denied.id, conf.id);

  // Confirmation must no longer be findable
  assert.throws(
    () => validateConfirmation(conf.id, "sess-1"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("deny with wrong session is rejected", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
  });

  assert.throws(
    () => denyConfirmation(conf.id, "sess-other"),
    (error) => error.code === "SESSION_MISMATCH",
  );
  // Confirm that the confirmation still exists for the correct session
  const stillValid = validateConfirmation(conf.id, "sess-1");
  assert.equal(stillValid.id, conf.id);
});

test("deny of non-existent confirmation returns CONFIRMATION_NOT_FOUND", () => {
  assert.throws(
    () => denyConfirmation("00000000-0000-0000-0000-000000000000", "sess-1"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});
