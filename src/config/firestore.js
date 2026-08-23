import { Firestore } from "@google-cloud/firestore";
import { logSafeError } from "../utils/safeLogging.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const DATABASE_ID_PATTERN = /^(?:\(default\)|[a-z][a-z0-9-]{1,61}[a-z0-9])$/u;
const LOCATION_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const COLLECTION_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const EMULATOR_HOST_PATTERN =
  /^(?:localhost|127\.0\.0\.1|\[::1\]):(?:[1-9][0-9]{2,4})$/u;

let firestoreClient = null;
let firestoreClientKey = null;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalidConfiguration(message, details = {}) {
  const error = new Error(message);
  error.code = "FIRESTORE_CONFIGURATION_INVALID";
  Object.assign(error, details);
  return error;
}

function parseEnabled(env) {
  const value = clean(env.FIRESTORE_ENABLED);
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw invalidConfiguration("FIRESTORE_ENABLED има невалидна стойност.");
}

function positiveTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 30_000)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function resolveFirestoreConfig(env = process.env) {
  const enabled = parseEnabled(env);
  const emulatorHost = clean(env.FIRESTORE_EMULATOR_HOST);

  if (!enabled) {
    return Object.freeze({
      enabled: false,
      mode: "disabled",
      projectId: null,
      databaseId: null,
      location: null,
      collectionPrefix: null,
      emulatorHost: null,
      requestTimeoutMs: positiveTimeout(env.FIRESTORE_REQUEST_TIMEOUT_MS),
    });
  }

  const projectId = clean(env.GCP_PROJECT_ID);
  const databaseId = clean(env.FIRESTORE_DATABASE_ID);
  const location = clean(env.FIRESTORE_LOCATION);
  const collectionPrefix = clean(env.FIRESTORE_COLLECTION_PREFIX);
  const missing = [];
  const invalid = [];

  if (!projectId) missing.push("GCP_PROJECT_ID");
  else if (!PROJECT_ID_PATTERN.test(projectId)) invalid.push("GCP_PROJECT_ID");
  if (!databaseId) missing.push("FIRESTORE_DATABASE_ID");
  else if (!DATABASE_ID_PATTERN.test(databaseId)) {
    invalid.push("FIRESTORE_DATABASE_ID");
  }
  if (!location) missing.push("FIRESTORE_LOCATION");
  else if (!LOCATION_PATTERN.test(location)) invalid.push("FIRESTORE_LOCATION");
  if (!collectionPrefix) missing.push("FIRESTORE_COLLECTION_PREFIX");
  else if (!COLLECTION_PREFIX_PATTERN.test(collectionPrefix)) {
    invalid.push("FIRESTORE_COLLECTION_PREFIX");
  }
  if (emulatorHost && !EMULATOR_HOST_PATTERN.test(emulatorHost)) {
    invalid.push("FIRESTORE_EMULATOR_HOST");
  }
  if (emulatorHost && clean(env.NODE_ENV) === "production") {
    invalid.push("FIRESTORE_EMULATOR_HOST_PRODUCTION");
  }

  if (missing.length || invalid.length) {
    throw invalidConfiguration(
      "Firestore е изрично включен, но конфигурацията не е валидна.",
      { missing, invalid },
    );
  }

  return Object.freeze({
    enabled: true,
    mode: "shadow",
    projectId,
    databaseId,
    location,
    collectionPrefix,
    emulatorHost: emulatorHost || null,
    requestTimeoutMs: positiveTimeout(env.FIRESTORE_REQUEST_TIMEOUT_MS),
  });
}

export function getFirestoreConfigurationStatus(env = process.env) {
  try {
    const config = resolveFirestoreConfig(env);
    return Object.freeze({
      status: config.enabled ? "configured" : "disabled",
      enabled: config.enabled,
      mode: config.mode,
      projectId: config.projectId,
      databaseId: config.databaseId,
      location: config.location,
      collectionPrefix: config.collectionPrefix,
      emulator: Boolean(config.emulatorHost),
      requestTimeoutMs: config.requestTimeoutMs,
      errorCode: null,
    });
  } catch (error) {
    return Object.freeze({
      status: "misconfigured",
      enabled: clean(env.FIRESTORE_ENABLED) === "true",
      mode: "shadow",
      projectId: null,
      databaseId: null,
      location: null,
      collectionPrefix: null,
      emulator: Boolean(clean(env.FIRESTORE_EMULATOR_HOST)),
      requestTimeoutMs: positiveTimeout(env.FIRESTORE_REQUEST_TIMEOUT_MS),
      errorCode: error?.code || "FIRESTORE_CONFIGURATION_INVALID",
      missing: Object.freeze(
        Array.isArray(error?.missing) ? error.missing : [],
      ),
      invalid: Object.freeze(
        Array.isArray(error?.invalid) ? error.invalid : [],
      ),
    });
  }
}

export function getFirestoreClient(env = process.env) {
  const config = resolveFirestoreConfig(env);
  if (!config.enabled) return null;

  const key = [
    config.projectId,
    config.databaseId,
    config.emulatorHost || "",
  ].join("\0");
  if (firestoreClient && firestoreClientKey === key) return firestoreClient;

  try {
    const clientOptions = {
      projectId: config.projectId,
      databaseId: config.databaseId,
      ...(config.emulatorHost
        ? { host: config.emulatorHost, ssl: false }
        : {}),
    };
    firestoreClient = new Firestore({
      ...clientOptions,
    });
    firestoreClientKey = key;
    return firestoreClient;
  } catch (error) {
    firestoreClient = null;
    firestoreClientKey = null;
    logSafeError("[Firestore] Client initialization failed", error);
    const initializationError = new Error(
      "Firestore client-ът не можа да бъде създаден.",
      { cause: error },
    );
    initializationError.code = "FIRESTORE_INITIALIZATION_FAILED";
    throw initializationError;
  }
}

export function resetFirestoreClientForTests() {
  firestoreClient = null;
  firestoreClientKey = null;
}
