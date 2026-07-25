import { randomUUID } from "node:crypto";

const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Allowed write actions — unknown ones are blocked by default
const ALLOWED_ACTIONS = new Set([
  "github.write:create_file",
  "github.write:update_file",
  "github.write:create_branch",
  "github.write:create_pr",
]);

// Fields that must never be stored in a confirmation (audit safety)
const SENSITIVE_PARAM_KEYS = new Set([
  "token",
  "password",
  "secret",
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
]);

const pendingConfirmations = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [id, conf] of pendingConfirmations) {
    if (conf.expiresAt < now) {
      pendingConfirmations.delete(id);
    }
  }
}

function sanitizeParams(params) {
  if (!params || typeof params !== "object") return {};
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!SENSITIVE_PARAM_KEYS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

export function isAllowedAction(action) {
  return ALLOWED_ACTIONS.has(action);
}

export function listAllowedActions() {
  return [...ALLOWED_ACTIONS];
}

/**
 * Creates a new pending confirmation.
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.action  – must be in ALLOWED_ACTIONS
 * @param {object} opts.resource – repository, branch, path, etc.
 * @param {object} [opts.params] – action parameters (sanitized before storage)
 * @param {number} [opts.ttlMs]  – override for tests; defaults to 10 min
 */
export function createConfirmation({
  sessionId,
  action,
  resource,
  params = {},
  ttlMs = CONFIRMATION_TTL_MS,
}) {
  purgeExpired();

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    const error = new Error("Липсва валидна сесия.");
    error.code = "MISSING_SESSION";
    throw error;
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    const error = new Error(
      `Непознато действие: "${action ?? ""}". Блокирано по подразбиране.`,
    );
    error.code = "UNKNOWN_ACTION";
    throw error;
  }

  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    const error = new Error("Липсва ресурс за действието.");
    error.code = "MISSING_RESOURCE";
    throw error;
  }

  const now = Date.now();
  const confirmation = {
    id: randomUUID(),
    sessionId: sessionId.trim(),
    action,
    resource: { ...resource },
    params: sanitizeParams(params),
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
    used: false,
  };

  pendingConfirmations.set(confirmation.id, confirmation);
  return confirmation;
}

/**
 * Validates a pending confirmation.
 * Throws with a typed error code on any failure.
 */
export function validateConfirmation(confirmationId, sessionId) {
  const conf = pendingConfirmations.get(confirmationId);

  if (!conf) {
    const error = new Error(
      "Потвърждението не е намерено или вече е изтекло.",
    );
    error.code = "CONFIRMATION_NOT_FOUND";
    throw error;
  }

  if (conf.used) {
    const error = new Error("Потвърждението вече е използвано.");
    error.code = "CONFIRMATION_ALREADY_USED";
    throw error;
  }

  if (Date.now() > conf.expiresAt) {
    pendingConfirmations.delete(confirmationId);
    const error = new Error("Потвърждението е изтекло. Направи ново искане.");
    error.code = "CONFIRMATION_EXPIRED";
    throw error;
  }

  if (conf.sessionId !== sessionId) {
    const error = new Error("Сесията не съответства на потвърждението.");
    error.code = "SESSION_MISMATCH";
    throw error;
  }

  return conf;
}

/**
 * Marks a confirmation as used and removes it from the store immediately.
 * Must be called before executing the action to prevent double-execution.
 */
export function markConfirmationUsed(confirmationId) {
  const conf = pendingConfirmations.get(confirmationId);
  if (conf) {
    conf.used = true;
    pendingConfirmations.delete(confirmationId);
  }
}

/**
 * Explicitly denies (cancels) a pending confirmation.
 */
export function denyConfirmation(confirmationId, sessionId) {
  const conf = pendingConfirmations.get(confirmationId);

  if (!conf) {
    const error = new Error("Потвърждението не е намерено.");
    error.code = "CONFIRMATION_NOT_FOUND";
    throw error;
  }

  if (conf.sessionId !== sessionId) {
    const error = new Error("Сесията не съответства на потвърждението.");
    error.code = "SESSION_MISMATCH";
    throw error;
  }

  pendingConfirmations.delete(confirmationId);
  return conf;
}

/** Test helper — clears all pending confirmations. */
export function resetConfirmationsForTests() {
  pendingConfirmations.clear();
}
