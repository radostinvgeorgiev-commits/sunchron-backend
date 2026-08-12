import { createFirestoreMemoryStore } from "./firestoreMemoryStore.js";
import { createFirestoreOperationalStore } from "./firestoreOperationalStore.js";

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

function failedCheck(error, fallbackCode) {
  const code = String(error?.code || "").trim();
  return {
    status: "unavailable",
    errorCode: /^[A-Z0-9_]{3,80}$/u.test(code) ? code : fallbackCode,
  };
}

export async function inspectStorageDependencies({
  loadFirestoreMemoryStore = ({ env }) => createFirestoreMemoryStore({ env }),
  loadFirestoreOperationalStore = ({ env }) =>
    createFirestoreOperationalStore({ env }),
  env = process.env,
  timeoutMs = env.STORAGE_HEALTH_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const boundedTimeoutMs = parsePositiveInteger(
    timeoutMs,
    DEFAULT_DEPENDENCY_TIMEOUT_MS,
  );
  let firestore;
  try {
    const [memory, operational] = await Promise.all([
      withTimeout(loadFirestoreMemoryStore({ env }).probe(), boundedTimeoutMs, "FIRESTORE_MEMORY_TIMEOUT"),
      Promise.resolve(loadFirestoreOperationalStore({ env })).then(() => ({ status: "healthy" })),
    ]);
    firestore = {
      status: memory?.status === "green" && operational?.status === "healthy" ? "healthy" : "unavailable",
      backend: "firestore",
      memory: memory?.status || "unknown",
      operational: operational?.status || "unknown",
      errorCode: null,
    };
  } catch (error) {
    firestore = { ...failedCheck(error, "FIRESTORE_UNAVAILABLE"), backend: "firestore" };
  }
  return {
    status: firestore.status === "healthy" ? "healthy" : "unavailable",
    checkedAt: now().toISOString(),
    checks: { firestore },
  };
}

export async function inspectStorageBackups({ now = () => new Date() } = {}) {
  return {
    status: "not-required",
    checkedAt: now().toISOString(),
    checks: {
      firestore: {
        status: "managed",
        readOnlyCheck: true,
        restoreTested: false,
        errorCode: null,
      },
    },
  };
}

export function createSingleFlightCache(loader, { ttlMs, now = () => Date.now() }) {
  let cached = null;
  let inFlight = null;
  return async function loadCached() {
    const currentTime = now();
    if (cached && currentTime - cached.storedAt < cached.ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(loader)
      .then((value) => {
        cached = { storedAt: now(), ttlMs: parsePositiveInteger(typeof ttlMs === "function" ? ttlMs(value) : ttlMs, 1), value };
        return value;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}
