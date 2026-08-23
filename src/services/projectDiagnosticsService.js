import { resolveFirestoreProjectId } from "../config/memoryBackend.js";
import { AI_CORE_PUBLIC_ORIGIN, getGoogleCloudRuntimeStatus } from "./googleCloudService.js";

const CLOUD_RUN_API = "https://run.googleapis.com/apis/serving.knative.dev/v1";
const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_SERVICE = "synchron-backend-google";
const DEFAULT_REGION = "europe-west1";
const DEFAULT_TRIGGER_NAME = "synchron-main-deploy";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TOOL_NAMES = 100;

function clean(value, maxLength = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : null;
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

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
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
  const response = await fetchWithTimeout(
    fetchImpl,
    METADATA_TOKEN_URL,
    { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  );
  const payload = await readJsonResponse(response);
  if (!response.ok || typeof payload?.access_token !== "string") {
    const error = new Error("metadata token unavailable");
    error.code = "GOOGLE_CLOUD_TOKEN_UNAVAILABLE";
    error.httpStatus = response.status;
    throw error;
  }
  return payload.access_token;
}

async function publicCheck(path, { origin, fetchImpl, timeoutMs }) {
  const url = `${origin}${path}`;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
    const payload = await readJsonResponse(response);
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

async function mcpDiscoveryCheck({ origin, fetchImpl, timeoutMs }) {
  try {
    const response = await fetchWithTimeout(
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
    const payload = await readJsonResponse(response);
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
    return { status: "fail", errorCode: safeErrorCode(error), toolCount: 0, tools: [] };
  }
}

async function googleApiCheck({ url, token, fetchImpl, timeoutMs, pick }) {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      timeoutMs,
    );
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      return { status: "fail", httpStatus: response.status, errorCode: "GOOGLE_CLOUD_API_FAILED" };
    }
    return { status: "pass", httpStatus: response.status, ...(pick(payload) || {}) };
  } catch (error) {
    return { status: "fail", errorCode: safeErrorCode(error) };
  }
}

function cloudRunSummary(payload) {
  const template = payload?.spec?.template?.spec;
  const container = Array.isArray(template?.containers) ? template.containers[0] : null;
  const annotations = payload?.metadata?.annotations || {};
  return {
    service: clean(payload?.metadata?.name, 80),
    latestReadyRevision: clean(payload?.status?.latestReadyRevisionName, 120),
    latestCreatedRevision: clean(payload?.status?.latestCreatedRevisionName, 120),
    image: clean(container?.image, 300),
    appCommit: clean(
      annotations["run.googleapis.com/client-version"] ||
        annotations["synchron-x/app-commit-sha"],
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

function latestBuildSummary(payload) {
  const builds = Array.isArray(payload?.builds) ? payload.builds : [];
  return {
    build: builds.length ? buildSummary(builds[0]) : null,
    count: builds.length,
  };
}

function overallStatus(checks) {
  const statuses = Object.values(checks).map((check) => check?.status);
  const passed = statuses.filter((status) => status === "pass").length;
  const failed = statuses.filter((status) => status === "fail").length;
  const unavailable = statuses.filter((status) => status === "unavailable").length;
  if (failed === 0 && unavailable === 0 && passed > 0) return "pass";
  if (passed > 0) return "partial";
  return "fail";
}

export async function getProjectDiagnostics({
  env = process.env,
  fetchImpl = fetch,
  accessTokenProvider,
  now = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const projectId = projectIdFromEnvironment(env);
  const service = clean(env.CLOUD_RUN_SERVICE || env.K_SERVICE || DEFAULT_SERVICE, 80);
  const region = clean(
    env.GOOGLE_CLOUD_REGION || env.GCP_REGION || env.CLOUD_RUN_REGION || DEFAULT_REGION,
    40,
  );
  // Diagnostics intentionally targets only the canonical production origin;
  // callers cannot turn this read-only check into an arbitrary URL fetcher.
  const origin = AI_CORE_PUBLIC_ORIGIN;
  const triggerId = clean(env.CLOUD_BUILD_TRIGGER_ID, 120);
  const triggerName =
    clean(env.CLOUD_BUILD_TRIGGER_NAME, 160) || DEFAULT_TRIGGER_NAME;
  const checks = {
    publicHealth: await publicCheck("/health", { origin, fetchImpl, timeoutMs }),
    readiness: await publicCheck("/health/ready", { origin, fetchImpl, timeoutMs }),
    mcp: await mcpDiscoveryCheck({ origin, fetchImpl, timeoutMs }),
  };

  let token = null;
  if (projectId) {
    try {
      token = await (accessTokenProvider || (() => metadataAccessToken(fetchImpl, timeoutMs)))();
    } catch (error) {
      const httpStatus = Number.isInteger(error?.httpStatus)
        ? error.httpStatus
        : null;
      checks.cloudRun = {
        status: "unavailable",
        errorCode: safeErrorCode(error),
        httpStatus,
      };
      checks.cloudBuildTrigger = {
        status: "unavailable",
        errorCode: safeErrorCode(error),
        httpStatus,
      };
      checks.cloudBuildLatest = {
        status: "unavailable",
        errorCode: safeErrorCode(error),
        httpStatus,
      };
    }
  } else {
    checks.cloudRun = { status: "unavailable", errorCode: "GOOGLE_CLOUD_PROJECT_UNAVAILABLE" };
    checks.cloudBuildTrigger = { status: "unavailable", errorCode: "GOOGLE_CLOUD_PROJECT_UNAVAILABLE" };
    checks.cloudBuildLatest = { status: "unavailable", errorCode: "GOOGLE_CLOUD_PROJECT_UNAVAILABLE" };
  }

  if (token && projectId) {
    checks.cloudRun = await googleApiCheck({
      token,
      fetchImpl,
      timeoutMs,
      url: `${CLOUD_RUN_API}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(service)}`,
      pick: cloudRunSummary,
    });
    checks.cloudBuildTrigger = triggerId
      ? await googleApiCheck({
          token,
          fetchImpl,
          timeoutMs,
          url: `${CLOUD_BUILD_API}/projects/${encodeURIComponent(projectId)}/triggers/${encodeURIComponent(triggerId)}`,
          pick: triggerSummary,
        })
      : await googleApiCheck({
          token,
          fetchImpl,
          timeoutMs,
          url: `${CLOUD_BUILD_API}/projects/${encodeURIComponent(projectId)}/triggers?pageSize=100`,
          pick: (payload) => triggerListSummary(payload, triggerName),
        });
    checks.cloudBuildLatest = await googleApiCheck({
      token,
      fetchImpl,
      timeoutMs,
      url: `${CLOUD_BUILD_API}/projects/${encodeURIComponent(projectId)}/builds?pageSize=10&orderBy=~create_time`,
      pick: latestBuildSummary,
    });
  }

  const runtime = getGoogleCloudRuntimeStatus({ env });
  const expectedCommit = clean(env.APP_COMMIT_SHA, 80);
  const observedCommits = [
    checks.publicHealth.commit,
    checks.readiness.commit,
    runtime.commit,
    checks.cloudBuildLatest.build?.commit,
  ].filter(Boolean);
  const commitConsistent = observedCommits.length > 1 && new Set(observedCommits).size === 1;

  return Object.freeze({
    status: overallStatus(checks),
    checkedAt: now(),
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
      matchesExpected: expectedCommit ? observedCommits.every((commit) => commit === expectedCommit) : null,
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
  const label = { pass: "PASS", partial: "PARTIAL", fail: "FAIL" }[report.status] || "UNKNOWN";
  const checkLines = Object.entries(report.checks || {}).map(([name, check]) => {
    const status = check?.status || "unknown";
    const details = [check?.httpStatus, check?.errorCode].filter(Boolean).join("; ");
    return `• ${name}: ${status.toUpperCase()}${details ? ` (${details})` : ""}`;
  });
  return [
    `Project diagnostics: ${label}.`,
    `• Project: ${report.projectId || "не е наличен"}.`,
    `• Service: ${report.service || report.runtime?.service || "не е наличен"}; region: ${report.region || "не е наличен"}.`,
    `• Revision: ${report.runtime?.revision || "не е наблюдавана"}.`,
    `• Commit: ${report.commit?.observed?.join(", ") || "не е наблюдаван"}${report.commit?.consistent ? " (съвпада)" : ""}.`,
    ...checkLines,
    "• Read-only проверка: да; secrets и произволни команди: не.",
  ].join("\n");
}
