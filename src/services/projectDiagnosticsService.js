import { resolveFirestoreProjectId } from "../config/memoryBackend.js";
import {
  AI_CORE_PUBLIC_ORIGIN,
  getGoogleCloudRuntimeStatus,
} from "./googleCloudService.js";
import {
  checkCloudProject,
  checkCloudRunSecretVersions,
  checkCloudRunTelemetry,
  cloudRunSecretReferences,
} from "./diagnosticsService.js";
import { inspectStorageDependencies } from "./storageHealthService.js";

const CLOUD_RUN_API = "https://run.googleapis.com/v2";
const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_SERVICE = "synchron-backend-google";
const DEFAULT_REGION = "europe-west1";
const DEFAULT_TRIGGER_NAME = "synchron-main-deploy";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TOOL_NAMES = 100;
const CLOUD_CHECKS = [
  "cloudRun",
  "cloudBuildTrigger",
  "cloudBuildLatest",
  "cloudProject",
  "monitoring",
  "logging",
  "secretManager",
];

function clean(value, maxLength = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : null;
}

function resourceNameSegment(value, maxLength = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  const segment = text.split("/").filter(Boolean).pop() || text;
  return clean(segment, maxLength);
}

function projectIdFromEnvironment(env) {
  const projectId = clean(resolveFirestoreProjectId(env), 80);
  return projectId && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)
    ? projectId
    : null;
}

function statusFromHttp(response) {
  return response?.ok ? "pass" : "fail";
}

function safeErrorCode(error) {
  const code = clean(error?.code, 80);
  return code && /^[A-Z0-9_.-]+$/u.test(code) ? code : "CHECK_FAILED";
}

async function fetchJsonWithTimeout(fetchImpl, url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    return { response, payload: await readJsonResponse(response) };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function metadataAccessToken(fetchImpl, timeoutMs) {
  const { response, payload } = await fetchJsonWithTimeout(
    fetchImpl,
    METADATA_TOKEN_URL,
    { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  );
  if (!response.ok || typeof payload?.access_token !== "string") {
    const error = new Error("metadata token unavailable");
    error.code = "GOOGLE_CLOUD_TOKEN_UNAVAILABLE";
    throw error;
  }
  return payload.access_token;
}

async function publicCheck(path, { origin, fetchImpl, timeoutMs }) {
  const url = `${origin}${path}`;
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      fetchImpl,
      url,
      {},
      timeoutMs,
    );
    return {
      status: statusFromHttp(response),
      httpStatus: response.status,
      reportedStatus: clean(payload?.status, 40),
      commit: clean(payload?.commit, 80),
      ...(path === "/health/ready"
        ? {
            reachable: payload?.reachable === true,
            responding: payload?.responding === true,
            tools: Number.isInteger(payload?.tools) ? payload.tools : null,
          }
        : {}),
    };
  } catch (error) {
    return { status: "fail", errorCode: safeErrorCode(error) };
  }
}

async function firestoreCheck(inspectStorage, env, timeoutMs) {
  try {
    const result = await inspectStorage({ env, timeoutMs });
    const check = result?.checks?.firestore;
    return check?.status === "healthy" && check.readOnlyCheck === true
      ? { status: "pass" }
      : { status: "fail", errorCode: "FIRESTORE_READ_PROBE_FAILED" };
  } catch (error) {
    return { status: "fail", errorCode: safeErrorCode(error) };
  }
}

async function mcpDiscoveryCheck({ origin, fetchImpl, timeoutMs }) {
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      fetchImpl,
      `${origin}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "project-diagnostics",
          method: "tools/list",
          params: {},
        }),
      },
      timeoutMs,
    );
    const tools = Array.isArray(payload?.result?.tools)
      ? payload.result.tools
          .map((tool) => clean(tool?.name, 120))
          .filter(Boolean)
          .slice(0, MAX_TOOL_NAMES)
      : [];
    return {
      status: response.ok && tools.length > 0 ? "pass" : "fail",
      httpStatus: response.status,
      toolCount: tools.length,
      tools,
    };
  } catch (error) {
    return {
      status: "fail",
      errorCode: safeErrorCode(error),
      toolCount: 0,
      tools: [],
    };
  }
}

async function googleApiCheck({
  url,
  token,
  fetchImpl,
  timeoutMs,
  pick,
  method = "GET",
  body,
}) {
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      fetchImpl,
      url,
      {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs,
    );
    if (!response.ok) {
      const disabled =
        Array.isArray(payload?.error?.details) &&
        payload.error.details.some(
          (detail) => detail?.reason === "SERVICE_DISABLED",
        );
      return {
        status: "fail",
        httpStatus: response.status,
        errorCode: disabled
          ? "GOOGLE_CLOUD_API_DISABLED"
          : response.status === 403
            ? "GOOGLE_CLOUD_PERMISSION_DENIED"
            : "GOOGLE_CLOUD_API_FAILED",
      };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        status: "fail",
        httpStatus: response.status,
        errorCode: "GOOGLE_CLOUD_INVALID_RESPONSE",
      };
    }
    return {
      status: "pass",
      httpStatus: response.status,
      ...(pick(payload) || {}),
    };
  } catch (error) {
    return { status: "fail", errorCode: safeErrorCode(error) };
  }
}

function cloudRunSummary(payload) {
  const containers = Array.isArray(payload?.template?.containers)
    ? payload.template.containers
    : Array.isArray(payload?.template?.spec?.containers)
      ? payload.template.spec.containers
      : payload?.spec?.template?.spec?.containers;
  const container = Array.isArray(containers) ? containers[0] : null;
  const annotations = {
    ...(payload?.metadata?.annotations || {}),
    ...(payload?.spec?.template?.metadata?.annotations || {}),
    ...(payload?.template?.annotations || {}),
    ...(payload?.template?.metadata?.annotations || {}),
    ...(payload?.annotations || {}),
  };
  const condition = clean(payload?.terminalCondition?.state, 40);
  return {
    ...(condition === "CONDITION_FAILED"
      ? { status: "fail", errorCode: "CLOUD_RUN_NOT_READY" }
      : {}),
    condition,
    service:
      resourceNameSegment(payload?.name, 80) ||
      resourceNameSegment(payload?.service, 80) ||
      resourceNameSegment(payload?.metadata?.name, 80),
    latestReadyRevision:
      resourceNameSegment(payload?.latestReadyRevision, 120) ||
      resourceNameSegment(payload?.status?.latestReadyRevisionName, 120) ||
      resourceNameSegment(payload?.status?.latestReadyRevision, 120),
    latestCreatedRevision:
      resourceNameSegment(payload?.latestCreatedRevision, 120) ||
      resourceNameSegment(payload?.status?.latestCreatedRevisionName, 120) ||
      resourceNameSegment(payload?.status?.latestCreatedRevision, 120),
    image: clean(container?.image, 300),
    appCommit: clean(
      annotations["synchron-x/app-commit-sha"] ||
        annotations["run.googleapis.com/client-version"],
      80,
    ),
  };
}

function triggerSummary(payload) {
  const github = payload?.github || {};
  const push = github.push || {};
  return {
    name: clean(payload?.name, 160),
    disabled: payload?.disabled === true,
    branch: clean(push.branch, 200),
    tag: clean(push.tag, 200),
    serviceAccount: clean(payload?.serviceAccount, 320),
    filename: clean(payload?.filename, 200),
  };
}

function triggerListSummary(payload, expectedName) {
  const triggers = Array.isArray(payload?.triggers) ? payload.triggers : [];
  const trigger = triggers.find(
    (candidate) =>
      clean(candidate?.name, 160) === expectedName ||
      clean(candidate?.displayName, 160) === expectedName,
  );
  if (!trigger) {
    return { status: "fail", errorCode: "CLOUD_BUILD_TRIGGER_NOT_FOUND" };
  }
  return {
    ...triggerSummary(trigger),
    triggerId: clean(trigger?.id, 120) || clean(trigger?.name, 160),
  };
}

function buildSummary(payload) {
  return {
    id: clean(payload?.id, 120),
    status: clean(payload?.status, 40),
    commit: clean(
      payload?.substitutions?.COMMIT_SHA ||
        payload?.substitutions?.REVISION_ID ||
        payload?.sourceProvenance?.resolvedRepoSource?.revisionName,
      80,
    ),
    createTime: clean(payload?.createTime, 50),
  };
}

function buildCreateTime(payload) {
  const createTime =
    typeof payload?.createTime === "string" ? payload.createTime : "";
  const timestamp = Date.parse(createTime);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function latestBuildSummary(payload) {
  const builds = Array.isArray(payload?.builds) ? payload.builds : [];
  const sortedBuilds = builds
    .slice()
    .sort((left, right) => buildCreateTime(right) - buildCreateTime(left));
  return {
    build: sortedBuilds.length ? buildSummary(sortedBuilds[0]) : null,
    count: builds.length,
  };
}

function overallStatus(checks) {
  const statuses = Object.values(checks).map((check) => check?.status);
  const passed = statuses.filter((status) => status === "pass").length;
  const failed = statuses.filter((status) => status === "fail").length;
  const unavailable = statuses.filter(
    (status) => status === "unavailable",
  ).length;
  if (failed === 0 && unavailable === 0 && passed > 0) return "pass";
  if (passed > 0) return "partial";
  return "fail";
}

export async function getProjectDiagnostics({
  env = process.env,
  fetchImpl = fetch,
  accessTokenProvider,
  inspectStorage = inspectStorageDependencies,
  now = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const projectId = projectIdFromEnvironment(env);
  const service = clean(
    env.CLOUD_RUN_SERVICE || env.K_SERVICE || DEFAULT_SERVICE,
    80,
  );
  const region = clean(
    env.GOOGLE_CLOUD_REGION ||
      env.GCP_REGION ||
      env.CLOUD_RUN_REGION ||
      DEFAULT_REGION,
    40,
  );
  // Diagnostics intentionally targets only the canonical production origin;
  // callers cannot turn this read-only check into an arbitrary URL fetcher.
  const origin = AI_CORE_PUBLIC_ORIGIN;
  const triggerId = clean(env.CLOUD_BUILD_TRIGGER_ID, 120);
  const triggerName =
    clean(env.CLOUD_BUILD_TRIGGER_NAME, 160) || DEFAULT_TRIGGER_NAME;
  const checkedAt = now();
  const publicOptions = { origin, fetchImpl, timeoutMs };
  const [publicHealth, readiness, mcp, firestore] = await Promise.all([
    publicCheck("/health", publicOptions),
    publicCheck("/health/ready", publicOptions),
    mcpDiscoveryCheck(publicOptions),
    firestoreCheck(inspectStorage, env, timeoutMs),
  ]);
  const checks = { publicHealth, readiness, mcp, firestore };

  let token = null;
  let unavailableCode = "GOOGLE_CLOUD_PROJECT_UNAVAILABLE";
  if (projectId) {
    unavailableCode = "GOOGLE_CLOUD_TOKEN_UNAVAILABLE";
    try {
      token = await (
        accessTokenProvider || (() => metadataAccessToken(fetchImpl, timeoutMs))
      )();
    } catch (error) {
      unavailableCode = safeErrorCode(error);
    }
  }

  if (token && projectId) {
    const check = (url, pick, options) =>
      googleApiCheck({ url, pick, token, fetchImpl, timeoutMs, ...options });
    let secretReferences;
    const runUrl = `${CLOUD_RUN_API}/projects/${projectId}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(service)}`;
    const buildUrl = `${CLOUD_BUILD_API}/projects/${projectId}`;
    const [
      cloudRun,
      cloudBuildTrigger,
      cloudBuildLatest,
      cloudProject,
      [monitoring, logging],
    ] = await Promise.all([
      check(runUrl, (payload) => {
        secretReferences = cloudRunSecretReferences(payload);
        return cloudRunSummary(payload);
      }),
      triggerId
        ? check(
            `${buildUrl}/triggers/${encodeURIComponent(triggerId)}`,
            triggerSummary,
          )
        : check(`${buildUrl}/triggers?pageSize=100`, (payload) =>
            triggerListSummary(payload, triggerName),
          ),
      check(`${buildUrl}/builds?pageSize=10`, latestBuildSummary),
      checkCloudProject({ check, projectId }),
      checkCloudRunTelemetry({ check, projectId, service, region, checkedAt }),
    ]);
    Object.assign(checks, {
      cloudRun,
      cloudBuildTrigger,
      cloudBuildLatest,
      cloudProject,
      monitoring,
      logging,
    });
    checks.secretManager = await checkCloudRunSecretVersions({
      check,
      cloudRun,
      references: secretReferences,
      projectId,
      projectNumber: cloudProject.projectNumber,
    });
  } else {
    for (const name of CLOUD_CHECKS) {
      checks[name] = { status: "unavailable", errorCode: unavailableCode };
    }
  }

  const runtime = getGoogleCloudRuntimeStatus({ env });
  const expectedCommit = clean(env.APP_COMMIT_SHA, 80);
  const observedCommits = [
    checks.publicHealth.commit,
    checks.readiness.commit,
    runtime.commit,
    checks.cloudBuildLatest.build?.commit,
  ].filter(Boolean);
  const commitConsistent =
    observedCommits.length > 1 && new Set(observedCommits).size === 1;

  return Object.freeze({
    status: overallStatus(checks),
    checkedAt,
    projectId,
    service,
    region,
    triggerId: triggerId || checks.cloudBuildTrigger?.triggerId || null,
    canonicalOrigin: origin,
    expectedCommit,
    runtime: {
      status: runtime.status,
      revision: runtime.revision,
      commit: runtime.commit,
      memoryBackend: runtime.memoryBackend,
      persistenceBackend: runtime.persistenceBackend,
      authBackend: runtime.authBackend,
    },
    commit: {
      observed: [...new Set(observedCommits)],
      expected: expectedCommit,
      consistent: commitConsistent,
      matchesExpected: expectedCommit
        ? observedCommits.every((commit) => commit === expectedCommit)
        : null,
    },
    checks,
    safety: {
      readOnly: true,
      secretsDisplayed: false,
      arbitraryCommands: false,
    },
  });
}

export function formatProjectDiagnostics(report) {
  const label =
    { pass: "PASS", partial: "PARTIAL", fail: "FAIL" }[report.status] ||
    "UNKNOWN";
  const checkLines = Object.entries(report.checks || {}).map(
    ([name, check]) => {
      const status = check?.status || "unknown";
      const details = [
        check?.httpStatus,
        check?.errorCode,
        ...(check?.errorCodes || []),
        typeof check?.samplePresent === "boolean"
          ? check.samplePresent
            ? "има метрики за последните 30 мин"
            : "няма метрики за последните 30 мин"
          : "",
        typeof check?.recentErrorFound === "boolean" && status === "pass"
          ? check.recentErrorFound
            ? "има скорошна грешка в Cloud Run"
            : "няма открита грешка в последните 30 мин"
          : "",
        Number.isInteger(check?.enabledVersions)
          ? `активни версии ${check.enabledVersions}/${check.referencedVersions}`
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `• ${name}: ${status.toUpperCase()}${details ? ` (${details})` : ""}`;
    },
  );
  return [
    `Project diagnostics: ${label}.`,
    `• Project: ${report.projectId || "не е наличен"}.`,
    `• Service: ${report.service || "не е наличен"} · region: ${report.region || "не е наличен"}.`,
    `• Commit: ${report.commit?.observed?.join(", ") || "не е наблюдаван"}${report.commit?.consistent ? " (съвпада)" : ""}.`,
    ...checkLines,
    "• Проверка само за четене. За тайните се проверяват метаданни за версиите.",
  ].join("\n");
}
