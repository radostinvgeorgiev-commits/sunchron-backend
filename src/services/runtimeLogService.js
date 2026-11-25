import { resolveFirestoreProjectId } from "../config/memoryBackend.js";

// Owner-only, read-only view of recent Cloud Run warnings and errors. Uses
// the Cloud Run service identity; filters are built server-side from a small
// allowlist and every log line is redacted before it leaves the server.

const LOGGING_API = "https://logging.googleapis.com/v2/entries:list";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SEVERITIES = Object.freeze(["DEFAULT", "INFO", "WARNING", "ERROR"]);
const MAX_TEXT = 600;

export class RuntimeLogError extends Error {
  constructor(message, status = 503, code = "RUNTIME_LOGS_UNAVAILABLE") {
    super(message);
    this.name = "RuntimeLogError";
    this.status = status;
    this.code = code;
  }
}

const REDACTIONS = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/gu, "[ключ]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/gu, "[ключ]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/gu, "[ключ]"],
  [/\bxai-[A-Za-z0-9_-]{12,}/gu, "[ключ]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, "[токен]"],
  [/\bya29\.[A-Za-z0-9._-]+/gu, "[токен]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [токен]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/gu, "[jwt]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[имейл]"],
  [/\b[A-Fa-f0-9]{40,}\b/gu, "[hex]"],
  [/(password|passwd|secret|token|api[_-]?key)(["'\s:=]+)[^\s"',}]+/giu, "$1$2[скрито]"],
];

export function redactLogText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function entryText(entry) {
  if (typeof entry?.textPayload === "string") return entry.textPayload;
  const json = entry?.jsonPayload;
  if (json && typeof json === "object") {
    return [json.message, json.msg, json.error, json.code]
      .filter((item) => typeof item === "string")
      .join(" · ");
  }
  if (entry?.httpRequest) {
    const request = entry.httpRequest;
    return `${request.requestMethod || ""} ${String(request.requestUrl || "").replace(/\?.*$/u, "")} → ${request.status || "?"}`;
  }
  return "";
}

async function metadataToken(fetchImpl) {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new RuntimeLogError("Няма достъп до Google Cloud от сървъра.");
  }
  return payload.access_token;
}

export async function readRuntimeLogs(
  { minutes = 60, severity = "WARNING", limit = 50, contains } = {},
  {
    env = process.env,
    fetchImpl = fetch,
    accessTokenProvider,
    now = Date.now,
  } = {},
) {
  const projectId = String(resolveFirestoreProjectId(env) || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
    throw new RuntimeLogError("Google Cloud проектът не е конфигуриран.");
  }
  const service = String(
    env.CLOUD_RUN_SERVICE || env.K_SERVICE || "synchron-backend-google",
  ).trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(service)) {
    throw new RuntimeLogError("Невалидна Cloud Run услуга.", 400);
  }
  const safeMinutes = Math.min(Math.max(Number.parseInt(minutes, 10) || 60, 1), 1440);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const safeSeverity = SEVERITIES.includes(severity) ? severity : "WARNING";
  const since = new Date(now() - safeMinutes * 60_000).toISOString();
  const filters = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${service}"`,
    `severity>=${safeSeverity}`,
    `timestamp>="${since}"`,
  ];
  if (typeof contains === "string" && contains.trim()) {
    const term = contains.trim().slice(0, 80);
    if (!/^[\p{L}\p{N} ._:\-[\]]+$/u.test(term)) {
      throw new RuntimeLogError(
        "Търсеният текст може да съдържа само букви, цифри, интервали и . _ : - [ ].",
        400,
        "RUNTIME_LOGS_INVALID_FILTER",
      );
    }
    filters.push(`"${term}"`);
  }
  const token = await (accessTokenProvider || (() => metadataToken(fetchImpl)))();
  const response = await fetchImpl(LOGGING_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resourceNames: [`projects/${projectId}`],
      filter: filters.join(" AND "),
      orderBy: "timestamp desc",
      pageSize: safeLimit,
    }),
  });
  if (!response.ok) {
    throw new RuntimeLogError(
      `Cloud Logging върна грешка ${response.status}.`,
      response.status === 403 ? 403 : 503,
      response.status === 403 ? "RUNTIME_LOGS_FORBIDDEN" : "RUNTIME_LOGS_UNAVAILABLE",
    );
  }
  const payload = await response.json().catch(() => ({}));
  const entries = (Array.isArray(payload?.entries) ? payload.entries : []).map(
    (entry) => ({
      timestamp: entry.timestamp || null,
      severity: entry.severity || "DEFAULT",
      revision: entry.resource?.labels?.revision_name || null,
      text: redactLogText(entryText(entry)),
    }),
  );
  return {
    service,
    minutes: safeMinutes,
    severity: safeSeverity,
    count: entries.length,
    entries,
  };
}
