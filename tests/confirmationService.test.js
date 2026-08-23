import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfirmation,
  denyConfirmation,
  isAllowedAction,
  listAllowedActions,
  markConfirmationUsed,
  resetConfirmationsForTests,
  requiresPersistentConfirmations,
  validateConfirmation,
} from "../src/services/confirmationService.js";

const VALID_ACTION = "github.write:code_task";
const VALID_RESOURCE = { repository: "owner/repo", baseRef: "main" };

test.beforeEach(() => {
  resetConfirmationsForTests();
});

// ─── isAllowedAction ──────────────────────────────────────────────────────────

test("recognises all declared write actions as allowed", () => {
  for (const action of listAllowedActions()) {
    assert.equal(
      isAllowedAction(action),
      true,
      `expected "${action}" to be allowed`,
    );
  }
});

test("rejects unknown actions", () => {
  assert.equal(isAllowedAction("github.write:delete_everything"), false);
  assert.equal(isAllowedAction("unknown"), false);
  assert.equal(isAllowedAction(""), false);
});

test("allows only the exact AI CORE code task action", () => {
  assert.equal(isAllowedAction("github.write:code_task"), true);
  assert.equal(isAllowedAction("github.write:push_main"), false);
});

test("allows only the exact bounded direct GitHub write actions", () => {
  for (const action of [
    "github.write:create_file",
    "github.write:update_file",
    "github.write:create_branch",
    "github.write:create_pr",
    "github.write:merge_pr",
    "github.write:close_issue",
  ]) {
    assert.equal(
      isAllowedAction(action),
      true,
      `expected "${action}" to be explicitly allowed`,
    );
  }
  for (const action of [
    "github.write:merge",
    "github.write:push_main",
    "github.write:change_secret",
    "github.write:deploy_production",
    "github.write:delete_repository",
  ]) {
    assert.equal(isAllowedAction(action), false);
  }
});

test("allows the exact Cloud Build trigger confirmation action", () => {
  assert.equal(
    isAllowedAction("infrastructure.write:run_cloud_build_trigger"),
    true,
  );
  assert.equal(
    isAllowedAction("infrastructure.write:run_arbitrary_command"),
    false,
  );
});

// ─── createConfirmation ───────────────────────────────────────────────────────

test("creates a confirmation with correct structure", () => {
  const conf = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    params: { content: "hello", message: "Add hello.txt" },
  });

  assert.ok(
    typeof conf.id === "string" && conf.id.length > 0,
    "id must be a non-empty string",
  );
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
        createConfirmation({
          sessionId,
          action: VALID_ACTION,
          resource: VALID_RESOURCE,
        }),
      (error) => error.code === "MISSING_SESSION",
      `should reject sessionId: ${JSON.stringify(sessionId)}`,
    );
  }
});

test("blocks missing resource", () => {
  assert.throws(
    () =>
      createConfirmation({
        sessionId: "sess-1",
        action: VALID_ACTION,
        resource: null,
      }),
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
    () =>
      validateConfirmation("00000000-0000-0000-0000-000000000000", "sess-1"),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("one confirmation cannot approve a different AI CORE task — ids are unique", () => {
  const conf1 = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    params: { prompt: "Create a.txt" },
  });

  const conf2 = createConfirmation({
    sessionId: "sess-1",
    action: VALID_ACTION,
    resource: VALID_RESOURCE,
    params: { prompt: "Create b.txt" },
  });

  // Using conf1's id only approves conf1's task, not conf2's
  const validated = validateConfirmation(conf1.id, "sess-1");
  assert.equal(validated.params.prompt, "Create a.txt");
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

test("requires durable confirmations in production", () => {
  assert.equal(
    requiresPersistentConfirmations({ NODE_ENV: "production" }),
    true,
  );
  assert.equal(requiresPersistentConfirmations({ NODE_ENV: "test" }), false);
});
