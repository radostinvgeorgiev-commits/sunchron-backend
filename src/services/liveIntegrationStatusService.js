import {
  isFirestoreMemoryConfigured,
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
  resolveMemoryBackend,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import {
  isIdentityPlatformConfigured,
  resolveIdentityPlatformProjectId,
} from "../config/authBackend.js";
import {
  isGitHubOAuthConfigured,
  isAuthorizedGitHubLogin,
} from "./githubOAuthService.js";
import {
  isCodexAgentConfigured,
} from "./codexAgentService.js";
import {
  getAiProviderStatus,
  isAiCoreConfigured,
} from "./aiCoreService.js";
import {
  createFirestoreMemoryStore,
} from "./firestoreMemoryStore.js";
import {
  getGoogleCloudRuntimeStatus,
} from "./googleCloudService.js";
import {
  getProjectDiagnostics,
} from "./projectDiagnosticsService.js";
import {
  isMcpOAuthConfigured,
  resolveMcpResourceUrl,
} from "./mcpOAuthService.js";
import { probeGoogleService } from "./googleDriveService.js";

const DEFAULT_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const DEFAULT_GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GROK_MODELS_URL = "https://api.x.ai/v1/models";
const DEFAULT_IDENTITY_PLATFORM_ORIGIN =
  "https://identitytoolkit.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_TIMEOUT_MS = 2_000;
const HTTP_STATUS_MIN = 400;
const HTTP_STATUS_MAX = 599;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeCode(value, fallback = "LIVE_CHECK_FAILED") {
  const code = String(value || "").trim();
  return /^[A-Z0-9_.-]{3,100}$/u.test(code) ? code : fallback;
}

function httpStatusFromError(error) {
  const status = Number(
    error?.httpStatus || error?.upstreamStatus || error?.status,
  );
  return status >= HTTP_STATUS_MIN && status <= HTTP_STATUS_MAX ? status : null;
}

function errorCodeFromError(error, fallback) {
  const status = httpStatusFromError(error);
  if (status) return safeCode(error?.code, `${fallback}_HTTP_${status}`);
  return safeCode(error?.code, fallback);
}

function failureAuthenticationStatus(httpStatus) {
  if (httpStatus === 401) return "requires_connection";
  if (httpStatus === 403 || httpStatus === 404) return "no_access";
  return "unknown";
}

function unavailableResult(
  configured,
  errorCode,
  authenticationStatus = configured ? "not_checked" : "not_configured",
) {
  return {
    configured,
    authenticated: false,
    authenticationStatus,
    liveVerified: false,
    healthStatus: configured ? "degraded" : "unavailable",
    httpStatus: null,
    availabilityCode: errorCode,
    availabilityReason: errorCode,
    smokeTest: {
      status: "not_run",
      readOnly: true,
      httpStatus: null,
      errorCode,
    },
  };
}

function passResult({
  configured = true,
  httpStatus = null,
  authenticationStatus = "authenticated",
  smokeKind = "read-only-http",
  details = {},
} = {}) {
  return {
    configured,
    authenticated: true,
    authenticationStatus,
    liveVerified: true,
    healthStatus: "healthy",
    httpStatus,
    availabilityCode: null,
    availabilityReason: null,
    smokeTest: {
      status: "passed",
      readOnly: true,
      httpStatus,
      kind: smokeKind,
      ...details,
    },
  };
}

function failedResult({
  configured = true,
  error,
  errorCode = "LIVE_CHECK_FAILED",
  httpStatus = httpStatusFromError(error),
  authenticationStatus = failureAuthenticationStatus(httpStatus),
  details = {},
} = {}) {
  const code = errorCodeFromError(error, errorCode);
  return {
    configured,
    authenticated: false,
    authenticationStatus,
    liveVerified: false,
    healthStatus: "degraded",
    httpStatus,
    availabilityCode: code,
    availabilityReason: code,
    smokeTest: {
      status: "failed",
      readOnly: true,
      httpStatus,
      errorCode: code,
      ...details,
    },
  };
}

function internalResult(configured = true) {
  return passResult({
    configured,
    authenticationStatus: "internal",
    smokeKind: "internal-executor",
  });
}

async function withTimeout(promise, timeoutMs, code = "LIVE_CHECK_TIMEOUT") {
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

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (cause) {
    const error = new Error("live request failed");
    error.code = cause?.name === "AbortError" ? "LIVE_CHECK_TIMEOUT" : "LIVE_CHECK_UNAVAILABLE";
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function responseText(response) {
  if (typeof response?.text !== "function") return "";
  return response.text().catch(() => "");
}

async function responseJson(response) {
  const text = await responseText(response);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function metadataAccessToken(fetchImpl, timeoutMs) {
  const tokenResponse = await fetchWithTimeout(
    fetchImpl,
    METADATA_TOKEN_URL,
    { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  );
  const tokenPayload = await responseJson(tokenResponse);
  if (!tokenResponse.ok || typeof tokenPayload?.access_token !== "string") {
    const error = new Error("Identity Platform service identity unavailable");
    error.code = "IDENTITY_PLATFORM_TOKEN_UNAVAILABLE";
    error.httpStatus = tokenResponse.status;
    throw error;
  }
  return tokenPayload.access_token;
}

async function requestHttp({
  fetchImpl,
  url,
  options = {},
  timeoutMs,
  parseJson = false,
}) {
  const response = await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
  const payload = parseJson ? await responseJson(response) : await responseText(response);
  if (!response.ok) {
    const error = new Error("live upstream request failed");
    error.code = `HTTP_${response.status}`;
    error.httpStatus = response.status;
    error.payload = payload;
    throw error;
  }
  return { response, payload };
}

function githubRepository(env) {
  const repository = String(env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).trim();
  return /^[^/]+\/[^/]+$/u.test(repository) ? repository : DEFAULT_REPOSITORY;
}

function githubApiUrl(env) {
  return String(env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL)
    .trim()
    .replace(/\/+$/u, "");
}

function bearerHeaders(token) {
  return token
    ? {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "AI CORE",
        "X-GitHub-Api-Version": "2022-11-28",
      }
    : {
        Accept: "application/vnd.github+json",
        "User-Agent": "AI CORE",
        "X-GitHub-Api-Version": "2022-11-28",
      };
}

async function probeGitHubRead({ env, githubSession, fetchImpl, timeoutMs }) {
  const token =
    githubSession?.accessToken || String(env.GITHUB_TOKEN || "").trim();
  const repository = githubRepository(env);
  try {
    const { response } = await requestHttp({
      fetchImpl,
      url: `${githubApiUrl(env)}/repos/${repository}`,
      options: { headers: bearerHeaders(token) },
      timeoutMs,
    });
    return passResult({
      httpStatus: response.status,
      authenticationStatus: token ? "authenticated" : "public",
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "GITHUB_READ_LIVE_CHECK_FAILED",
    });
  }
}

async function probeGitHubWrite({ env, githubSession, fetchImpl, timeoutMs }) {
  if (!isGitHubOAuthConfigured(env)) {
    return unavailableResult(false, "GITHUB_OAUTH_NOT_CONFIGURED");
  }
  if (!githubSession?.accessToken) {
    return unavailableResult(true, "GITHUB_SESSION_REQUIRED", "requires_connection");
  }
  if (
    githubSession.expiresAt &&
    Date.now() >= Number(githubSession.expiresAt)
  ) {
    return unavailableResult(true, "GITHUB_SESSION_EXPIRED", "requires_connection");
  }

  try {
    const profile = await requestHttp({
      fetchImpl,
      url: `${githubApiUrl(env)}/user`,
      options: { headers: bearerHeaders(githubSession.accessToken) },
      timeoutMs,
      parseJson: true,
    });
    const login = String(profile.payload?.login || "").trim();
    if (!login || !isAuthorizedGitHubLogin(login, env)) {
      const error = new Error("GitHub owner login is not authorized");
      error.code = "OWNER_GITHUB_LOGIN_REQUIRED";
      error.httpStatus = 403;
      return failedResult({
        error,
        authenticationStatus: "no_access",
      });
    }

    const repository = await requestHttp({
      fetchImpl,
      url: `${githubApiUrl(env)}/repos/${githubRepository(env)}`,
      options: { headers: bearerHeaders(githubSession.accessToken) },
      timeoutMs,
    });
    return passResult({
      httpStatus: repository.response.status,
      authenticationStatus: "authenticated",
      details: { ownerLoginVerified: true },
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "GITHUB_WRITE_LIVE_CHECK_FAILED",
    });
  }
}

function providerConfiguration(provider, env) {
  if (provider === "openai") {
    return {
      key: String(env.OPENAI_API_KEY || "").trim(),
      url: env.OPENAI_MODELS_URL || DEFAULT_OPENAI_MODELS_URL,
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    };
  }
  if (provider === "gemini") {
    return {
      key: String(env.GEMINI_API_KEY || "").trim(),
      url: DEFAULT_GEMINI_MODELS_URL,
      headers: () => ({}),
      queryKey: true,
    };
  }
  if (provider === "grok") {
    return {
      key: String(env.GROK_API_KEY || "").trim(),
      url: env.GROK_MODELS_URL || DEFAULT_GROK_MODELS_URL,
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    };
  }
  return null;
}

async function probeAiProvider({
  provider,
  env,
  fetchImpl,
  timeoutMs,
}) {
  const configuration = providerConfiguration(provider, env);
  if (!configuration?.key) {
    return unavailableResult(false, `${String(provider).toUpperCase()}_NOT_CONFIGURED`);
  }
  const url = new URL(configuration.url);
  if (configuration.queryKey) url.searchParams.set("key", configuration.key);
  try {
    const { response } = await requestHttp({
      fetchImpl,
      url: url.href,
      options: { headers: configuration.headers(configuration.key) },
      timeoutMs,
    });
    return passResult({
      httpStatus: response.status,
      authenticationStatus: "authenticated",
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: `${String(provider).toUpperCase()}_LIVE_CHECK_FAILED`,
    });
  }
}

async function probeFirestore({ env, fetchImpl, timeoutMs }) {
  if (
    resolveMemoryBackend(env) !== "firestore" ||
    !isFirestoreMemoryConfigured(env)
  ) {
    return unavailableResult(false, "FIRESTORE_NOT_CONFIGURED");
  }
  try {
    const result = await withTimeout(
      createFirestoreMemoryStore({ env, fetchImpl }).probe(),
      timeoutMs,
    );
    return passResult({
      httpStatus: null,
      authenticationStatus: "service_identity",
      details: { backend: result?.backend || "firestore" },
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "FIRESTORE_LIVE_CHECK_FAILED",
      authenticationStatus: "service_identity",
    });
  }
}

async function probeIdentityPlatform({
  env,
  fetchImpl,
  timeoutMs,
  accessTokenProvider,
}) {
  if (!isIdentityPlatformConfigured(env)) {
    return unavailableResult(false, "IDENTITY_PLATFORM_NOT_CONFIGURED");
  }
  const projectId = resolveIdentityPlatformProjectId(env);
  try {
    const accessToken =
      typeof accessTokenProvider === "function"
        ? await accessTokenProvider()
        : await metadataAccessToken(fetchImpl, timeoutMs);
    if (!String(accessToken || "").trim()) {
      const error = new Error("Identity Platform service identity unavailable");
      error.code = "IDENTITY_PLATFORM_TOKEN_UNAVAILABLE";
      throw error;
    }
    const url = new URL(
      `/admin/v2/projects/${encodeURIComponent(projectId)}/config`,
      DEFAULT_IDENTITY_PLATFORM_ORIGIN,
    );
    const { response } = await requestHttp({
      fetchImpl,
      url: url.href,
      options: {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
      timeoutMs,
    });
    return passResult({
      httpStatus: response.status,
      authenticationStatus: "authenticated",
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "IDENTITY_PLATFORM_LIVE_CHECK_FAILED",
    });
  }
}

async function probeGoogleAdapter({
  env,
  googleSessionId,
  adapter,
  fetchImpl,
  timeoutMs,
}) {
  const configured = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]
    .every((name) => Boolean(String(env[name] || "").trim()));
  if (!configured) return unavailableResult(false, "GOOGLE_NOT_CONFIGURED");
  if (!googleSessionId) {
    return unavailableResult(true, "GOOGLE_SESSION_REQUIRED", "requires_connection");
  }
  try {
    const result = await withTimeout(
      probeGoogleService(googleSessionId, adapter, fetchImpl),
      timeoutMs,
    );
    return passResult({
      httpStatus: result.httpStatus,
      authenticationStatus: "authenticated",
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "GOOGLE_LIVE_CHECK_FAILED",
    });
  }
}

function firstDiagnosticFailure(checks = {}) {
  for (const [name, check] of Object.entries(checks)) {
    if (check?.status === "fail" || check?.status === "unavailable") {
      return {
        name,
        httpStatus: Number.isInteger(check.httpStatus) ? check.httpStatus : null,
        errorCode: safeCode(
          check.errorCode,
          `GOOGLE_CLOUD_${name.toUpperCase()}_FAILED`,
        ),
      };
    }
  }
  return null;
}

function cloudResultFromDiagnostics(report, runtime) {
  const checks = report?.checks || {};
  const publicHealth = checks.publicHealth?.status === "pass";
  const readiness = checks.readiness?.status === "pass";
  const cloudRun = checks.cloudRun?.status === "pass";
  if (publicHealth && readiness && cloudRun) {
    return passResult({
      httpStatus: checks.cloudRun?.httpStatus || checks.publicHealth?.httpStatus,
      authenticationStatus: "service_identity",
      details: {
        service: report?.runtime?.service || runtime.service || null,
        revision: report?.runtime?.revision || runtime.revision || null,
        commit: report?.runtime?.commit || runtime.commit || null,
      },
    });
  }
  const failure = firstDiagnosticFailure(checks) || {
    errorCode: "GOOGLE_CLOUD_LIVE_CHECK_FAILED",
    httpStatus: null,
  };
  return failedResult({
    errorCode: failure.errorCode,
    httpStatus: failure.httpStatus,
    authenticationStatus:
      failure.httpStatus === 401 || failure.httpStatus === 403
        ? failureAuthenticationStatus(failure.httpStatus)
        : "service_identity",
  });
}

async function probeGoogleCloud({ env, fetchImpl, timeoutMs, diagnostics }) {
  const runtime = getGoogleCloudRuntimeStatus({ env });
  if (!runtime.configured) {
    const unavailable = unavailableResult(false, "GOOGLE_CLOUD_NOT_CONFIGURED");
    return {
      runtime,
      diagnostics: null,
      cloud: unavailable,
      diagnosticTool: unavailable,
      dependencies: {
        cloudRun: unavailable,
        cloudBuild: unavailable,
      },
    };
  }

  let report;
  try {
    report = await withTimeout(
      diagnostics({ env, fetchImpl, timeoutMs }),
      timeoutMs * 4,
      "GOOGLE_CLOUD_DIAGNOSTICS_TIMEOUT",
    );
  } catch (error) {
    const failed = failedResult({
      error,
      errorCode: "GOOGLE_CLOUD_DIAGNOSTICS_FAILED",
      authenticationStatus: "service_identity",
    });
    return {
      runtime,
      diagnostics: null,
      cloud: failed,
      diagnosticTool: failed,
      dependencies: { cloudRun: failed, cloudBuild: failed },
    };
  }

  const cloud = cloudResultFromDiagnostics(report, runtime);
  const cloudRunCheck = report?.checks?.cloudRun;
  const cloudBuildCheck = report?.checks?.cloudBuildLatest;
  const dependency = (check, code) => {
    if (check?.status === "pass") {
      return passResult({
        httpStatus: check.httpStatus,
        authenticationStatus: "service_identity",
      });
    }
    return failedResult({
      errorCode: check?.errorCode || code,
      httpStatus: Number.isInteger(check?.httpStatus) ? check.httpStatus : null,
      authenticationStatus: "service_identity",
    });
  };
  const diagnosticsHealthy = report?.status === "pass";
  const diagnosticTool = diagnosticsHealthy
    ? passResult({
        httpStatus: cloudBuildCheck?.httpStatus || null,
        authenticationStatus: "service_identity",
      })
    : failedResult({
        errorCode:
          firstDiagnosticFailure(report?.checks)?.errorCode ||
          "GOOGLE_CLOUD_DIAGNOSTICS_PARTIAL",
        httpStatus: firstDiagnosticFailure(report?.checks)?.httpStatus || null,
        authenticationStatus: "service_identity",
      });
  return {
    runtime,
    diagnostics: report,
    cloud,
    diagnosticTool,
    dependencies: {
      cloudRun: dependency(cloudRunCheck, "CLOUD_RUN_LIVE_CHECK_FAILED"),
      cloudBuild: dependency(cloudBuildCheck, "CLOUD_BUILD_LIVE_CHECK_FAILED"),
    },
  };
}

async function probeMcp({ env, fetchImpl, timeoutMs }) {
  if (!isMcpOAuthConfigured(env)) {
    return unavailableResult(false, "MCP_OAUTH_NOT_CONFIGURED");
  }
  const resource = resolveMcpResourceUrl(env);
  if (!resource) return unavailableResult(false, "MCP_RESOURCE_NOT_CONFIGURED");
  const token = String(env.MCP_ACCESS_TOKEN || "").trim();
  if (!token) {
    return unavailableResult(true, "MCP_SESSION_REQUIRED", "requires_connection");
  }
  try {
    const { response, payload } = await requestHttp({
      fetchImpl,
      url: resource,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "live-status",
          method: "tools/list",
          params: {},
        }),
      },
      timeoutMs,
      parseJson: true,
    });
    const tools = Array.isArray(payload?.result?.tools)
      ? payload.result.tools
      : [];
    if (!tools.length) {
      const error = new Error("MCP tools list is empty");
      error.code = "MCP_TOOLS_NOT_FOUND";
      error.httpStatus = response.status;
      throw error;
    }
    return passResult({
      httpStatus: response.status,
      authenticationStatus: "authenticated",
      details: { toolCount: tools.length },
    });
  } catch (error) {
    return failedResult({
      error,
      errorCode: "MCP_LIVE_CHECK_FAILED",
    });
  }
}

function persistenceResult({ env, firestore }) {
  if (!isPersistenceBackendConfigured(env)) {
    return unavailableResult(false, "PERSISTENCE_NOT_CONFIGURED");
  }
  if (resolvePersistenceBackend(env) === "firestore") return firestore;
  return unavailableResult(
    true,
    "PERSISTENCE_LIVE_CHECK_UNAVAILABLE",
    "unknown",
  );
}

function dependentCoreResult({ configured, provider, memory, errorCode }) {
  if (!configured) {
    return unavailableResult(false, errorCode);
  }
  if (
    provider.healthStatus === "healthy" &&
    memory.healthStatus === "healthy"
  ) {
    return passResult({
      httpStatus: provider.httpStatus,
      authenticationStatus: "authenticated",
      details: { providerLive: true, memoryLive: true },
    });
  }
  return failedResult({
    errorCode:
      provider.availabilityCode ||
      memory.availabilityCode ||
      "AI_CORE_DEPENDENCY_FAILED",
    httpStatus: provider.httpStatus || memory.httpStatus,
    authenticationStatus:
      provider.authenticationStatus === "requires_connection"
        ? "requires_connection"
        : "unknown",
  });
}

function codeWriteStatus(githubWrite, providerResults) {
  if (githubWrite.healthStatus !== "healthy") return githubWrite;

  const failedProvider = ["openai", "gemini", "grok"]
    .map((provider) => [provider, providerResults[provider]])
    .find(([, result]) => result?.healthStatus !== "healthy");
  if (!failedProvider) return githubWrite;

  const [provider, result] = failedProvider;
  if (!result?.configured) {
    return unavailableResult(
      false,
      `GITHUB_WRITE_${provider.toUpperCase()}_NOT_CONFIGURED`,
    );
  }
  return failedResult({
    errorCode: `GITHUB_WRITE_${provider.toUpperCase()}_LIVE_CHECK_FAILED`,
    httpStatus: result.httpStatus,
    authenticationStatus: result.authenticationStatus,
  });
}

function toolStatusMap({
  githubRead,
  githubWrite,
  codeWrite,
  google,
  firestore,
  persistence,
  providerResults,
  conversation,
  codex,
  cloud,
  cloudDiagnostics,
  mcp,
}) {
  const googleTool = (adapter) => google[adapter];
  const cloudRead = cloud.cloud;
  return {
    "synchron-agent-chat": conversation,
    "synchron-integrations-status": internalResult(),
    "synchron-system-inspector": internalResult(),
    "github-read": githubRead,
    "github-write": codeWrite,
    "github-confirmed-write": githubWrite,
    "openai-codex": codex,
    "google-drive-read": googleTool("drive"),
    "google-calendar-read": googleTool("calendar"),
    "google-calendar-write": googleTool("calendar"),
    "gmail-read": googleTool("gmail"),
    "google-contacts": googleTool("contacts"),
    "synchron-tasks": persistence,
    "openai-web-search": providerResults.openai,
    "google-cloud-read": cloudRead,
    "google-cloud-diagnostics": cloudDiagnostics,
    "google-cloud-write": cloudRead,
    "google-firestore-memory": firestore,
    "mcp": mcp,
    "google-cloud-run": cloud?.dependencies?.cloudRun || null,
    "google-cloud-build": cloud?.dependencies?.cloudBuild || null,
  };
}

export async function getLiveIntegrationReport({
  env = process.env,
  githubSession = null,
  googleSessionId = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = env.INTEGRATION_STATUS_TIMEOUT_MS,
  diagnostics = getProjectDiagnostics,
  identityAccessTokenProvider,
  now = () => new Date(),
} = {}) {
  const boundedTimeoutMs = parsePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  const providerStatus = getAiProviderStatus(env);
  const providerResults = {};
  const providerCache = new Map();
  const loadProvider = (provider) => {
    if (!providerCache.has(provider)) {
      providerCache.set(
        provider,
        probeAiProvider({
          provider,
          env,
          fetchImpl,
          timeoutMs: boundedTimeoutMs,
        }),
      );
    }
    return providerCache.get(provider);
  };

  const [
    githubRead,
    githubWrite,
    firestore,
    googleDrive,
    googleCalendar,
    gmail,
    googleContacts,
    cloud,
    mcp,
  ] = await Promise.all([
    probeGitHubRead({
      env,
      githubSession,
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeGitHubWrite({
      env,
      githubSession,
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeFirestore({ env, fetchImpl, timeoutMs: boundedTimeoutMs }),
    probeGoogleAdapter({
      env,
      googleSessionId,
      adapter: "drive",
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeGoogleAdapter({
      env,
      googleSessionId,
      adapter: "calendar",
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeGoogleAdapter({
      env,
      googleSessionId,
      adapter: "gmail",
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeGoogleAdapter({
      env,
      googleSessionId,
      adapter: "contacts",
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
    }),
    probeGoogleCloud({
      env,
      fetchImpl,
      timeoutMs: boundedTimeoutMs,
      diagnostics,
    }),
    probeMcp({ env, fetchImpl, timeoutMs: boundedTimeoutMs }),
  ]);

  for (const provider of ["openai", "gemini", "grok"]) {
    providerResults[provider] = await loadProvider(provider);
  }
  const codeWrite = codeWriteStatus(githubWrite, providerResults);
  const selectedProviderResult =
    providerResults[providerStatus.selectedProvider] ||
    unavailableResult(false, "AI_PROVIDER_NOT_CONFIGURED");
  const memoryStatus =
    resolveMemoryBackend(env) === "firestore"
      ? firestore
      : persistenceResult({ env, firestore });
  const conversation = dependentCoreResult({
    configured:
      isAiCoreConfigured(env) &&
      isMemoryBackendConfigured(env),
    provider: selectedProviderResult,
    memory: memoryStatus,
    errorCode: "AI_CORE_CONVERSATION_NOT_CONFIGURED",
  });
  const codex = isCodexAgentConfigured(env)
    ? providerResults.openai.healthStatus === "healthy"
      ? passResult({
          httpStatus: providerResults.openai.httpStatus,
          authenticationStatus: "authenticated",
          smokeKind: "internal-executor",
        })
      : failedResult({
          errorCode:
            providerResults.openai.availabilityCode ||
            "CODEX_PROVIDER_LIVE_CHECK_FAILED",
          httpStatus: providerResults.openai.httpStatus,
        })
    : unavailableResult(false, "CODEX_AGENT_NOT_CONFIGURED");
  const persistence = persistenceResult({ env, firestore });
  const tools = toolStatusMap({
    githubRead,
    githubWrite,
    codeWrite,
    google: {
      drive: googleDrive,
      calendar: googleCalendar,
      gmail,
      contacts: googleContacts,
    },
    firestore,
    persistence,
    providerResults,
    conversation,
    codex,
    cloud,
    cloudDiagnostics: cloud.diagnosticTool,
    mcp,
  });

  return Object.freeze({
    checkedAt: now().toISOString(),
    provider: providerStatus,
    tools: Object.freeze(tools),
    dependencies: Object.freeze({
      identityPlatform: await probeIdentityPlatform({
        env,
        fetchImpl,
        timeoutMs: boundedTimeoutMs,
        accessTokenProvider: identityAccessTokenProvider,
      }),
      firestore,
      cloudRun: cloud.dependencies.cloudRun,
      cloudBuild: cloud.dependencies.cloudBuild,
      mcp,
    }),
    core: Object.freeze({
      conversation,
      identityPlatform: null,
      mcp,
    }),
    googleCloud: cloud,
    safety: Object.freeze({
      readOnly: true,
      secretsDisplayed: false,
      writesExecuted: false,
    }),
  });
}
