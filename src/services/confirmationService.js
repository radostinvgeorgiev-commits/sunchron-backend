import { randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { logSafeError } from "../utils/safeLogging.js";
import {
  decryptGitHubSession,
  encryptGitHubSession,
} from "./githubOAuthService.js";
import { createFirestoreOperationalStore } from "./firestoreOperationalStore.js";

const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CONFIRMATION_INDEX =
  process.env.CONFIRMATION_INDEX || "synchron-confirmations-v1";

// Only explicitly listed, narrow write flows may create confirmations.
// Legacy direct GitHub writes and arbitrary infrastructure writes stay blocked.
const ALLOWED_ACTIONS = new Set([
  "github.copilot:start_task",
  "github.write:delete_merged_branches",
  "infrastructure.digitalocean:activate_tester_auth",
  "infrastructure.digitalocean:add_www_domain",
  "calendar.write:create_event",
  "memory.write:save_profile",
  "memory.write:update_profile",
  "memory.delete:profile",
  "tasks.write:update_status",
  "mail.send:draft",
  "mail.delete:message",
  "contacts.write:create",
  "contacts.write:update",
  "github.write:create_branch",
  "github.write:create_file",
  "github.write:update_file",
  "github.write:create_pr",
  "github.write:close_issue",
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
let firestoreOperationalStore = null;
let firestoreOperationalConfiguration = null;
let firestoreOperationalStoreOverride = null;

export function setFirestoreConfirmationStoreForTests(store) {
  firestoreOperationalStoreOverride = store || null;
  firestoreOperationalStore = null;
  firestoreOperationalConfiguration = null;
}

function persistenceError() {
  const error = new Error(
    "Потвърждението не може да бъде запазено или проверено устойчиво.",
  );
  error.code = "CONFIRMATION_PERSISTENCE_FAILED";
  return error;
}

export function requiresPersistentConfirmations(env = process.env) {
  return env.NODE_ENV === "production";
}

function persistenceBackendOrThrow() {
  const backend = resolvePersistenceBackend(process.env);
  if (!backend) throw persistenceError();
  return backend;
}

function getFirestoreOperationalStoreOrThrow() {
  if (firestoreOperationalStoreOverride) {
    return firestoreOperationalStoreOverride;
  }
  const configuration = [
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.GCLOUD_PROJECT,
    process.env.GCP_PROJECT_ID,
    process.env.FIRESTORE_DATABASE_ID,
    process.env.FIRESTORE_CONFIRMATION_COLLECTION,
  ].join("\0");
  if (
    !firestoreOperationalStore ||
    firestoreOperationalConfiguration !== configuration
  ) {
    firestoreOperationalStore = createFirestoreOperationalStore({
      env: process.env,
    });
    firestoreOperationalConfiguration = configuration;
  }
  return firestoreOperationalStore;
}

async function persistConfirmation(confirmation) {
  if (persistenceBackendOrThrow() === "firestore") {
    await getFirestoreOperationalStoreOrThrow().saveConfirmation(
      confirmation.id,
      encryptGitHubSession(confirmation),
    );
    return true;
  }
  const client = getOpenSearchClient();
  if (!client) return false;
  await client.index({
    index: CONFIRMATION_INDEX,
    id: confirmation.id,
    body: encryptGitHubSession(confirmation),
    refresh: true,
  });
  return true;
}

async function loadStoredConfirmation(id) {
  if (persistenceBackendOrThrow() === "firestore") {
    try {
      const document =
        await getFirestoreOperationalStoreOrThrow().getConfirmation(id);
      return document ? decryptGitHubSession(document.data) : null;
    } catch {
      throw persistenceError();
    }
  }
  const client = getOpenSearchClient();
  if (!client) return null;
  try {
    const response = await client.get({
      index: CONFIRMATION_INDEX,
      id,
    });
    return decryptGitHubSession(response.body?._source ?? response._source);
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status === 404) return null;
    throw persistenceError();
  }
}

async function removeStoredConfirmation(id) {
  if (persistenceBackendOrThrow() === "firestore") {
    try {
      return await getFirestoreOperationalStoreOrThrow().deleteConfirmation(id);
    } catch {
      throw persistenceError();
    }
  }
  const client = getOpenSearchClient();
  if (!client) return false;
  try {
    await client.delete({
      index: CONFIRMATION_INDEX,
      id,
      refresh: true,
    });
    return true;
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status === 404) return false;
    throw persistenceError();
  }
}

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
  };

  pendingConfirmations.set(confirmation.id, confirmation);
  return confirmation;
}

export async function createDurableConfirmation(options) {
  const confirmation = createConfirmation(options);
  let persisted = false;
  try {
    persisted = await persistConfirmation(confirmation);
  } catch (error) {
    if (requiresPersistentConfirmations()) {
      pendingConfirmations.delete(confirmation.id);
      throw persistenceError();
    }
    logSafeError("[Confirmation] Persistence failure", error);
  }

  if (!persisted && requiresPersistentConfirmations()) {
    pendingConfirmations.delete(confirmation.id);
    throw persistenceError();
  }
  return confirmation;
}

/**
 * Validates a pending confirmation.
 * Throws with a typed error code on any failure.
 */
export function validateConfirmation(confirmationId, sessionId) {
  const conf = pendingConfirmations.get(confirmationId);

  if (!conf) {
    const error = new Error("Потвърждението не е намерено или вече е изтекло.");
    error.code = "CONFIRMATION_NOT_FOUND";
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

export async function validateDurableConfirmation(confirmationId, sessionId) {
  if (!pendingConfirmations.has(confirmationId)) {
    const stored = await loadStoredConfirmation(confirmationId);
    if (stored) pendingConfirmations.set(stored.id, stored);
  }
  return validateConfirmation(confirmationId, sessionId);
}

/**
 * Marks a confirmation as used by removing it from the store immediately.
 * Must be called before executing the action to prevent double-execution.
 */
export function markConfirmationUsed(confirmationId) {
  pendingConfirmations.delete(confirmationId);
}

export async function markDurableConfirmationUsed(confirmationId) {
  if (requiresPersistentConfirmations()) {
    const removed = await removeStoredConfirmation(confirmationId);
    if (!removed) throw persistenceError();
  } else {
    try {
      await removeStoredConfirmation(confirmationId);
    } catch (error) {
      logSafeError("[Confirmation] Delete failure", error);
    }
  }
  markConfirmationUsed(confirmationId);
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
  setFirestoreConfirmationStoreForTests(null);
}
