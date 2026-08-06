import { getOpenSearchClient } from "../config/opensearch.js";
import { getDigitalOceanOpenSearchBackupAudit } from "./digitalOceanService.js";
import { checkSupabaseStatus } from "./supabaseService.js";

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 5_000;
const DEFAULT_BACKUP_TIMEOUT_MS = 15_000;
const DEFAULT_OPENSEARCH_BACKUP_MAX_AGE_HOURS = 48;

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

function failedCheck(error, fallbackCode) {
  return {
    status: "unavailable",
    errorCode: safeErrorCode(error, fallbackCode),
  };
}

async function inspectOpenSearch({
  loadOpenSearchClient,
  memoryIndex,
  timeoutMs,
}) {
  try {
    const client = loadOpenSearchClient();
    if (!client) {
      return {
        status: "unavailable",
        clusterStatus: "not-configured",
        errorCode: "OPENSEARCH_NOT_CONFIGURED",
      };
    }

    const [response] = await Promise.all([
      withTimeout(
        client.cluster.health({}, { requestTimeout: timeoutMs, maxRetries: 0 }),
        timeoutMs,
        "OPENSEARCH_TIMEOUT",
      ),
      withTimeout(
        client.search(
          {
            index: memoryIndex,
            body: {
              size: 0,
              track_total_hits: false,
              query: {
                term: { ownerId: "__synchron_health_monitor_no_user__" },
              },
              _source: false,
            },
          },
          { requestTimeout: timeoutMs, maxRetries: 0 },
        ),
        timeoutMs,
        "OPENSEARCH_INDEX_READ_TIMEOUT",
      ),
    ]);
    const clusterStatus =
      response?.body?.status || response?.status || "unknown";
    const healthy = ["green", "yellow"].includes(clusterStatus);
    return {
      status: healthy ? "healthy" : "unavailable",
      clusterStatus,
      memoryIndexReadable: healthy,
      errorCode: healthy ? null : "OPENSEARCH_CLUSTER_UNHEALTHY",
      tlsVerificationRequired: true,
    };
  } catch (error) {
    return failedCheck(error, "OPENSEARCH_UNAVAILABLE");
  }
}

async function inspectSupabase({ checkSupabase, timeoutMs }) {
  try {
    const result = await withTimeout(
      checkSupabase({ timeoutMs }),
      timeoutMs,
      "SUPABASE_TIMEOUT",
    );
    const connectionSource = ["runtime", "public-bootstrap"].includes(
      result?.connectionSource,
    )
      ? result.connectionSource
      : null;
    return {
      status: result?.status === "healthy" ? "healthy" : "unavailable",
      responseTimeMs:
        Number.isFinite(result?.responseTimeMs) && result.responseTimeMs >= 0
          ? result.responseTimeMs
          : null,
      ...(connectionSource ? { connectionSource } : {}),
      errorCode: result?.status === "healthy" ? null : "SUPABASE_UNAVAILABLE",
    };
  } catch (error) {
    return failedCheck(error, "SUPABASE_UNAVAILABLE");
  }
}

export async function inspectStorageDependencies({
  loadOpenSearchClient = getOpenSearchClient,
  checkSupabase = checkSupabaseStatus,
  memoryIndex = process.env.MEMORY_INDEX || "synchron-profile-memory-v1",
  timeoutMs = process.env.STORAGE_HEALTH_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const boundedTimeoutMs = parsePositiveInteger(
    timeoutMs,
    DEFAULT_DEPENDENCY_TIMEOUT_MS,
  );
  const [opensearch, supabase] = await Promise.all([
    inspectOpenSearch({
      loadOpenSearchClient,
      memoryIndex,
      timeoutMs: boundedTimeoutMs,
    }),
    inspectSupabase({ checkSupabase, timeoutMs: boundedTimeoutMs }),
  ]);
  const healthy =
    opensearch.status === "healthy" && supabase.status === "healthy";

  return {
    status: healthy ? "healthy" : "unavailable",
    checkedAt: now().toISOString(),
    checks: { opensearch, supabase },
  };
}

function summarizeOpenSearchBackups(audit, { now, maxAgeHours }) {
  const backups = Array.isArray(audit?.databaseBackups)
    ? audit.databaseBackups
    : [];
  const verified = backups.filter((item) => item?.status === "verified");
  const restorePointCount = verified.reduce(
    (total, item) => total + Math.max(0, Number(item.backupCount) || 0),
    0,
  );
  const dates = verified
    .flatMap((item) => [item.oldestCreatedAt, item.newestCreatedAt])
    .filter(
      (value) =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort();
  const fullyVerified =
    backups.length > 0 && verified.length === backups.length;
  const newestCreatedAt = dates.at(-1) || null;
  const newestTimestamp = newestCreatedAt ? Date.parse(newestCreatedAt) : NaN;
  const backupAgeMs = now.getTime() - newestTimestamp;
  const backupIsFresh =
    Number.isFinite(backupAgeMs) &&
    backupAgeMs >= -5 * 60_000 &&
    backupAgeMs <= maxAgeHours * 60 * 60_000;
  const status =
    fullyVerified && restorePointCount > 0 && backupIsFresh
      ? "verified"
      : fullyVerified
        ? restorePointCount === 0
          ? "empty"
          : "stale"
        : "unverified";

  return {
    status,
    restorePointCount: fullyVerified ? restorePointCount : null,
    oldestCreatedAt: dates[0] || null,
    newestCreatedAt,
    fresh: status === "verified",
    checkedAt: audit?.checkedAt || null,
    readOnlyCheck: true,
    restoreTested: false,
    errorCode:
      status === "verified"
        ? null
        : status === "empty"
          ? "OPENSEARCH_RESTORE_POINTS_EMPTY"
          : status === "stale"
            ? "OPENSEARCH_RESTORE_POINTS_STALE"
            : backups[0]?.errorCode || "OPENSEARCH_BACKUPS_UNVERIFIED",
  };
}

export async function inspectStorageBackups({
  loadOpenSearchBackupAudit = getDigitalOceanOpenSearchBackupAudit,
  timeoutMs = process.env.BACKUP_HEALTH_TIMEOUT_MS,
  maxAgeHours = process.env.OPENSEARCH_BACKUP_MAX_AGE_HOURS,
  now = () => new Date(),
} = {}) {
  const checkedAt = now();
  const boundedMaxAgeHours = parsePositiveInteger(
    maxAgeHours,
    DEFAULT_OPENSEARCH_BACKUP_MAX_AGE_HOURS,
  );
  let opensearch;
  const controller = new AbortController();
  try {
    const audit = await withTimeout(
      loadOpenSearchBackupAudit({ signal: controller.signal }),
      parsePositiveInteger(timeoutMs, DEFAULT_BACKUP_TIMEOUT_MS),
      "OPENSEARCH_BACKUP_TIMEOUT",
    );
    opensearch = summarizeOpenSearchBackups(audit, {
      now: checkedAt,
      maxAgeHours: boundedMaxAgeHours,
    });
  } catch (error) {
    opensearch = {
      ...failedCheck(error, "OPENSEARCH_BACKUPS_UNAVAILABLE"),
      restorePointCount: null,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      fresh: false,
      checkedAt: null,
      readOnlyCheck: true,
      restoreTested: false,
    };
  } finally {
    controller.abort();
  }

  const opensearchVerified =
    opensearch.status === "verified" && opensearch.restorePointCount > 0;
  return {
    status: opensearchVerified ? "partially-verified" : "unavailable",
    checkedAt: checkedAt.toISOString(),
    checks: {
      opensearch,
      supabase: {
        status: "unverified",
        errorCode: "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
        reason:
          "The runtime publishable key can verify Supabase Auth availability, but cannot verify provider backup policy.",
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
