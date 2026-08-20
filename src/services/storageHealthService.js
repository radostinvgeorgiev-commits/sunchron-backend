import { createFirestoreMemoryStore } from "./firestoreMemoryStore.js";
import {
  getUserAuthProvider,
  isUserAuthConfigured,
  isUserRegistrationEnabled,
} from "./userAuthService.js";

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 5_000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || "").trim();
  return /^[A-Z0-9_]{3,80}$/u.test(code) ? code : fallback;
}

export async function inspectStorageDependencies({
  env = process.env,
  loadFirestoreStore = createFirestoreMemoryStore,
  getAuthStatus = (runtimeEnv) => ({
    configured: isUserAuthConfigured(runtimeEnv),
    provider: getUserAuthProvider(runtimeEnv),
    registrationEnabled: isUserRegistrationEnabled(runtimeEnv),
  }),
  timeoutMs = env.STORAGE_HEALTH_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const boundedTimeoutMs = parsePositiveInteger(
    timeoutMs,
    DEFAULT_DEPENDENCY_TIMEOUT_MS,
  );
  let firestore;
  try {
    const response = await withTimeout(
      loadFirestoreStore({ env }).probe(),
      boundedTimeoutMs,
      "FIRESTORE_TIMEOUT",
    );
    const healthy = response?.status === "green";
    firestore = {
      status: healthy ? "healthy" : "unavailable",
      databaseStatus: response?.status || "unknown",
      readOnlyCheck: true,
      errorCode: healthy ? null : "FIRESTORE_UNAVAILABLE",
    };
  } catch (error) {
    firestore = {
      status: "unavailable",
      databaseStatus: "unavailable",
      readOnlyCheck: true,
      errorCode: safeErrorCode(error, "FIRESTORE_UNAVAILABLE"),
    };
  }

  const auth = getAuthStatus(env);
  const identityPlatform = {
    status: auth.configured ? "healthy" : "unavailable",
    provider: auth.provider,
    registrationEnabled: auth.registrationEnabled === true,
    errorCode: auth.configured ? null : "IDENTITY_PLATFORM_NOT_CONFIGURED",
  };
  const healthy =
    firestore.status === "healthy" && identityPlatform.status === "healthy";
  return {
    status: healthy ? "healthy" : "unavailable",
    checkedAt: now().toISOString(),
    checks: { firestore, identityPlatform },
  };
}

export async function inspectStorageBackups({ now = () => new Date() } = {}) {
  return {
    status: "unverified",
    checkedAt: now().toISOString(),
    checks: {
      firestore: {
        status: "unverified",
        errorCode: "FIRESTORE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
        restoreTested: false,
        reason:
          "Firestore backup schedules and restore points must be verified in Google Cloud Console.",
      },
    },
  };
}

export function createSingleFlightCache(
  loader,
  { ttlMs, now = () => Date.now() },
) {
  let cached = null;
  let inFlight = null;
  return async function loadCached() {
    const currentTime = now();
    if (cached && currentTime - cached.storedAt < cached.ttlMs) {
      return cached.value;
    }
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(loader)
      .then((value) => {
        const resolvedTtlMs = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
        cached = {
          storedAt: now(),
          ttlMs: parsePositiveInteger(resolvedTtlMs, 1),
          value,
        };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
