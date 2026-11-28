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

const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
// A weekly copy counts as fresh for 8 days (one week plus one day of slack).
const BACKUP_FRESH_MS = 8 * 24 * 60 * 60 * 1_000;

function unverifiedBackupReport(checkedAt, errorCode, reason) {
  return {
    status: "unverified",
    checkedAt,
    checks: {
      firestore: {
        status: "unverified",
        errorCode,
        readOnlyCheck: true,
        restoreTested: false,
        reason,
      },
    },
  };
}

async function readGoogleJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.code =
      response.status === 403
        ? "FIRESTORE_BACKUP_PERMISSION_DENIED"
        : "FIRESTORE_BACKUP_STATUS_FAILED";
    throw error;
  }
  return response.json();
}

// Reads, never writes, the weekly Firestore backup schedule and the copies
// Google has made of the live database. Only dates and counts are returned.
export async function inspectStorageBackups({
  now = () => new Date(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const checkedAt = now().toISOString();
  const projectId = String(
    env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT_ID || "",
  ).trim();
  const databaseId = String(env.FIRESTORE_DATABASE_ID || "(default)").trim();
  if (!env.K_SERVICE || !projectId) {
    return unverifiedBackupReport(
      checkedAt,
      "FIRESTORE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
      "Firestore backup schedules and restore points must be verified in Google Cloud Console.",
    );
  }
  try {
    const tokenResponse = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    const token = tokenResponse.ok
      ? (await tokenResponse.json())?.access_token
      : null;
    if (!token) {
      return unverifiedBackupReport(
        checkedAt,
        "FIRESTORE_BACKUP_TOKEN_UNAVAILABLE",
        "The runtime could not read the backup status.",
      );
    }
    const project = encodeURIComponent(projectId);
    const database = `projects/${projectId}/databases/${databaseId}`;
    const [schedulesPayload, backupsPayload] = await Promise.all([
      readGoogleJson(
        `${FIRESTORE_API}/projects/${project}/databases/${encodeURIComponent(databaseId)}/backupSchedules`,
        token,
        fetchImpl,
      ),
      readGoogleJson(
        `${FIRESTORE_API}/projects/${project}/locations/-/backups`,
        token,
        fetchImpl,
      ),
    ]);
    const weekly = (schedulesPayload.backupSchedules || []).find(
      (schedule) => schedule?.weeklyRecurrence,
    );
    const ready = (backupsPayload.backups || [])
      .filter(
        (backup) =>
          backup?.state === "READY" &&
          String(backup.database || "").endsWith(database),
      )
      .map((backup) => String(backup.snapshotTime || ""))
      .filter(Boolean)
      .sort();
    const latestBackupAt = ready.at(-1) || null;
    const fresh =
      latestBackupAt !== null &&
      now().getTime() - Date.parse(latestBackupAt) <= BACKUP_FRESH_MS;
    if (!weekly) {
      return {
        status: "unverified",
        checkedAt,
        checks: {
          firestore: {
            status: "missing",
            errorCode: "FIRESTORE_WEEKLY_BACKUP_NOT_SCHEDULED",
            readOnlyCheck: true,
            restoreTested: false,
            scheduled: false,
            backupCount: ready.length,
            latestBackupAt,
          },
        },
      };
    }
    return {
      status: fresh ? "verified" : "scheduled",
      checkedAt,
      checks: {
        firestore: {
          status: fresh ? "verified" : "scheduled",
          errorCode: fresh ? null : "FIRESTORE_BACKUP_NOT_YET_MADE",
          readOnlyCheck: true,
          restoreTested: false,
          scheduled: true,
          day: weekly.weeklyRecurrence.day || null,
          retention: weekly.retention || null,
          backupCount: ready.length,
          latestBackupAt,
        },
      },
    };
  } catch (error) {
    return unverifiedBackupReport(
      checkedAt,
      error?.code || "FIRESTORE_BACKUP_STATUS_FAILED",
      "The runtime could not read the backup status.",
    );
  }
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
        const resolvedTtlMs =
          typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
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
