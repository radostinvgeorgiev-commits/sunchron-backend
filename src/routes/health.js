import express from "express";
import {
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
  resolveMemoryBackend,
} from "../config/memoryBackend.js";
import { resolveRuntimeVersion } from "../config/runtimeVersion.js";
import { getMemoryStartupVerificationStatus } from "../services/memoryStartupVerificationService.js";
import {
  getGitHubSession,
  isAuthorizedGitHubLogin,
  isGitHubOAuthConfigured,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import {
  MCP_TOOLS,
  createMcpRequestHandler,
} from "../services/mcpReadService.js";
import {
  getMcpOpenAiTunnelRuntimeStatus,
  getMcpOAuthRuntimeStatus,
  isMcpOAuthConfigured,
} from "../services/mcpOAuthService.js";
import { isCodexAgentConfigured } from "../services/codexAgentService.js";
import {
  createSingleFlightCache,
  inspectStorageBackups,
  inspectStorageDependencies,
} from "../services/storageHealthService.js";
import { isToolExecutable } from "../tools/capabilityEngine.js";
import { listTools, registerCoreTools } from "../tools/toolRegistry.js";
import {
  getAiProviderStatus,
  isAiCoreConfigured,
} from "../services/aiCoreService.js";
import { createFirestoreMemoryStore } from "../services/firestoreMemoryStore.js";
import { getGoogleCloudRuntimeStatus } from "../services/googleCloudService.js";
import {
  hasSession as hasGoogleSession,
  parseCookies as parseGoogleCookies,
} from "../services/googleDriveService.js";
import { getLiveIntegrationReport } from "../services/liveIntegrationStatusService.js";
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";

const router = express.Router();
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_BACKUP_ROUTE_TIMEOUT_MS = 10_000;
const FAILED_BACKUP_CACHE_TTL_MS = 15_000;
const loadStorageDependencies = createSingleFlightCache(
  inspectStorageDependencies,
  { ttlMs: 30_000 },
);
const loadStorageBackups = createSingleFlightCache(inspectStorageBackups, {
  ttlMs: resolveStorageBackupCacheTtlMs,
});

router.use((_req, res, next) => {
  setPrivateHealthHeaders(res);
  next();
});

export function getRuntimeVersion(env = process.env) {
  return resolveRuntimeVersion(env);
}

router.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "synchron-backend",
    ...getRuntimeVersion(),
  });
});

function hasAllEnvironmentVariables(env, ...names) {
  return names.every((name) => Boolean(env[name]));
}

export function resolveStorageBackupCacheTtlMs(
  _report,
) {
  return FAILED_BACKUP_CACHE_TTL_MS;
}

async function withTimeout(promise, timeoutMs, code = "READINESS_TIMEOUT") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getReadinessStatus({
  env = process.env,
  loadFirestoreMemoryStore = createFirestoreMemoryStore,
  loadMemoryVerificationStatus = getMemoryStartupVerificationStatus,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  const aiProviderStatus = getAiProviderStatus(env);
  const chatAgentReady = aiProviderStatus.configured;
  let memory = { ready: false, status: "unavailable" };

  const memoryBackend = resolveMemoryBackend(env);
  try {
    if (memoryBackend === "firestore") {
      const store = loadFirestoreMemoryStore({ env });
      const response = await withTimeout(store.probe(), timeoutMs);
      memory = {
        ready: response?.status === "green",
        status: response?.status || "unknown",
        backend: "firestore",
      };
    } else {
      memory = { ready: false, status: "invalid-backend", backend: null };
    }
  } catch {
    memory = {
      ready: false,
      status: "unavailable",
      backend: memoryBackend === "firestore" ? "firestore" : null,
    };
  }

  const bridge = (await getBridgeDiagnosticsStatus({ env, timeoutMs })).bridge;
  const memoryVerification = loadMemoryVerificationStatus();
  const memoryVerificationRequired = env.NODE_ENV === "production";
  const memoryVerificationReady =
    !memoryVerificationRequired || memoryVerification.status === "works";
  const ready = chatAgentReady && memory.ready && memoryVerificationReady;
  return {
    status: ready ? "ready" : "not-ready",
    ...getRuntimeVersion(env),
    checks: {
      chatAgent: {
        ready: chatAgentReady,
        status: chatAgentReady ? "configured" : "not-configured",
        primaryProvider: aiProviderStatus.selectedProvider,
        providers: aiProviderStatus.providers,
      },
      memory,
      memoryAcceptance: {
        required: memoryVerificationRequired,
        ready: memoryVerificationReady,
        status: memoryVerification.status,
        attempts: memoryVerification.attempts,
        startedAt: memoryVerification.startedAt,
        finishedAt: memoryVerification.finishedAt,
        isolated: memoryVerification.isolated,
        realMemoryUnchanged: memoryVerification.realMemoryUnchanged,
        cleanupCompleted: memoryVerification.cleanupCompleted,
        passedSteps: memoryVerification.passedSteps,
        errorCode: memoryVerification.errorCode,
      },
      bridge,
    },
  };
}

export function createReadinessHandler(options = {}) {
  return async function readinessHandler(req, res) {
    const result = await getReadinessStatus(options);
    res.status(result.status === "ready" ? 200 : 503).json(result);
  };
}

router.get("/ready", createReadinessHandler());

function setPrivateHealthHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

export function createStorageDependenciesHandler({
  loadStatus = loadStorageDependencies,
} = {}) {
  return async function storageDependenciesHandler(_req, res) {
    setPrivateHealthHeaders(res);
    const result = await loadStatus();
    res.status(result.status === "healthy" ? 200 : 503).json(result);
  };
}

function publicBackupStatus(report) {
  return {
    status: report.status,
    checkedAt: report.checkedAt,
    checks: {
      firestore: {
        status: report.checks?.firestore?.status || "unverified",
        errorCode:
          report.checks?.firestore?.errorCode ||
          "FIRESTORE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
        restoreTested: false,
        provesRestore: false,
      },
    },
  };
}

export function createStorageBackupsHandler({
  loadStatus = loadStorageBackups,
  timeoutMs = DEFAULT_BACKUP_ROUTE_TIMEOUT_MS,
} = {}) {
  return async function storageBackupsHandler(_req, res) {
    setPrivateHealthHeaders(res);
    let report;
    try {
      report = await withTimeout(
        loadStatus(),
        timeoutMs,
        "BACKUP_HEALTH_TIMEOUT",
      );
    } catch {
      report = unavailableBackupReport();
    }
    const result = publicBackupStatus(report);
    res.status(result.status === "verified" ? 200 : 503).json(result);
  };
}

function unavailableDependencyReport() {
  return {
    status: "unavailable",
    checkedAt: new Date().toISOString(),
    checks: {
      opensearch: {
        status: "unavailable",
        errorCode: "STORAGE_DEPENDENCY_REPORT_FAILED",
      },
      supabase: {
        status: "unavailable",
        errorCode: "STORAGE_DEPENDENCY_REPORT_FAILED",
      },
    },
  };
}

function unavailableBackupReport() {
  return {
    status: "unavailable",
    checkedAt: new Date().toISOString(),
    checks: {
      firestore: {
        status: "unverified",
        errorCode: "FIRESTORE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
        restoreTested: false,
        provesRestore: false,
      },
    },
  };
}

export function createStorageReportHandler({
  loadDependencies = loadStorageDependencies,
  loadBackups = loadStorageBackups,
  now = () => new Date(),
} = {}) {
  return async function storageReportHandler(_req, res) {
    setPrivateHealthHeaders(res);
    const [dependenciesResult, backupsResult] = await Promise.allSettled([
      loadDependencies(),
      loadBackups(),
    ]);
    const dependencies =
      dependenciesResult.status === "fulfilled"
        ? dependenciesResult.value
        : unavailableDependencyReport();
    const backups =
      backupsResult.status === "fulfilled"
        ? publicBackupStatus(backupsResult.value)
        : unavailableBackupReport();

    res.status(200).json({
      status: "reported",
      checkedAt: now().toISOString(),
      dependencies,
      backups,
    });
  };
}

router.get("/dependencies", createStorageDependenciesHandler());
router.get("/backups", createStorageBackupsHandler());
router.get("/storage-report", createStorageReportHandler());

export async function getBridgeDiagnosticsStatus({
  env = process.env,
  handleMcpRequest = createMcpRequestHandler(),
  timeoutMs = 1_000,
} = {}) {
  const configured =
    typeof env.MCP_ACCESS_TOKEN === "string" &&
    env.MCP_ACCESS_TOKEN.length >= 32;
  let responding = false;
  const readOnlyTools = MCP_TOOLS.filter(
    (tool) => tool.annotations?.readOnlyHint === true,
  ).length;
  const destructiveTools = MCP_TOOLS.filter(
    (tool) => tool.annotations?.destructiveHint === true,
  ).length;

  try {
    const response = await withTimeout(
      handleMcpRequest(
        { jsonrpc: "2.0", id: "diagnostics", method: "initialize" },
        env.MEMORY_OWNER_ID || "primary-user",
      ),
      timeoutMs,
    );
    responding = response?.result?.serverInfo?.name === "synchron-x-memory";
  } catch {
    responding = false;
  }

  return {
    status: configured && responding ? "operational" : "incomplete",
    ...getRuntimeVersion(env),
    bridge: {
      protocol: "mcp-streamable-http",
      endpoint: "/mcp",
      configured,
      reachable: true,
      responding,
      readOnly: destructiveTools === 0,
      tools: MCP_TOOLS.length,
      readOnlyTools,
      destructiveTools,
      authentication: {
        mode: "oauth2-with-legacy-static-bearer",
        chatgptOAuthReady: isMcpOAuthConfigured(env),
        discovery: "/.well-known/oauth-protected-resource",
        tokenExchange: getMcpOAuthRuntimeStatus(),
        secureTunnel: getMcpOpenAiTunnelRuntimeStatus(env),
      },
    },
  };
}

export function createBridgeDiagnosticsHandler(options = {}) {
  return async function bridgeDiagnosticsHandler(_req, res) {
    const result = await getBridgeDiagnosticsStatus(options);
    res.status(result.status === "operational" ? 200 : 503).json(result);
  };
}

router.get("/bridge", createBridgeDiagnosticsHandler());
router.get("/mcp-status", createBridgeDiagnosticsHandler());

function hasAllProcessEnvironmentVariables(...names) {
  return hasAllEnvironmentVariables(process.env, ...names);
}

function resolveToolHealthStatus(tool, configuration = {}) {
  if (
    !tool.enabled ||
    configuration.runtimeEnabled === false ||
    !configuration.configured
  ) {
    return "unavailable";
  }
  if (configuration.authenticated === false) return "degraded";
  if (configuration.liveVerified === false) return "degraded";
  return "healthy";
}

function formatLiveIntegrationStatus(liveReport) {
  registerCoreTools();
  const tools = listTools().map((tool) => {
    const live = liveReport.tools[tool.id] || {
      configured: false,
      authenticated: false,
      authenticationStatus: "unknown",
      liveVerified: false,
      healthStatus: "unavailable",
      availabilityCode: "LIVE_STATUS_NOT_REPORTED",
      availabilityReason: "LIVE_STATUS_NOT_REPORTED",
      httpStatus: null,
      smokeTest: {
        status: "not_run",
        readOnly: true,
        httpStatus: null,
        errorCode: "LIVE_STATUS_NOT_REPORTED",
      },
    };
    return {
      id: tool.id,
      name: tool.name,
      enabled: tool.enabled,
      executable: isToolExecutable(tool.id),
      configured: Boolean(live.configured),
      authenticated: Boolean(live.authenticated),
      authenticationStatus: live.authenticationStatus || "unknown",
      liveVerified: Boolean(live.liveVerified),
      healthStatus: live.healthStatus || "unavailable",
      availabilityCode: live.availabilityCode || null,
      availabilityReason: live.availabilityReason || null,
      httpStatus: live.httpStatus || null,
      smokeTest: live.smokeTest || null,
      requiresConfirmation: tool.requiresConfirmation,
      readOnly: !tool.requiresConfirmation,
    };
  });
  const chatAgent = liveReport.tools["synchron-agent-chat"];
  const firestore = liveReport.tools["google-firestore-memory"];
  const identityPlatform = liveReport.dependencies?.identityPlatform || null;
  const liveTools = tools.filter((tool) => tool.enabled);
  const overallStatus = liveTools.every(
    (tool) => tool.healthStatus === "healthy",
  )
    ? "healthy"
    : liveTools.some((tool) => tool.healthStatus === "healthy")
      ? "degraded"
      : "unavailable";
  const googleCloud = liveReport.googleCloud || {};
  return {
    status: "ok",
    overallStatus,
    checkedAt: liveReport.checkedAt,
    ...getRuntimeVersion(),
    core: {
      chatAgent: {
        ...liveReport.provider,
        ...chatAgent,
      },
      openai: {
        configured: Boolean(liveReport.provider?.providers?.find(
          ({ id }) => id === "openai",
        )?.configured),
        ...(liveReport.provider?.selectedProvider === "openai"
          ? liveReport.tools["openai-codex"]
          : {}),
      },
      memory: {
        ...firestore,
        backend:
          googleCloud.runtime?.memoryBackend ||
          (firestore?.configured ? "firestore" : null),
      },
      identityPlatform,
      mcp: liveReport.tools.mcp,
    },
    tools,
    dependencies: liveReport.dependencies,
    googleCloud: {
      ...googleCloud.runtime,
      configured: Boolean(googleCloud.runtime?.configured),
      healthStatus: googleCloud.cloud?.healthStatus || "unavailable",
      liveVerified: Boolean(googleCloud.cloud?.liveVerified),
      diagnostics: googleCloud.diagnostics,
      dependencies: googleCloud.dependencies,
    },
    safety: liveReport.safety,
  };
}

export function getIntegrationStatus({
  githubAuthenticated = false,
  liveReport = null,
} = {}) {
  if (liveReport) return formatLiveIntegrationStatus(liveReport);
  registerCoreTools();
  const googleCloud = getGoogleCloudRuntimeStatus();
  const configuration = {
    "synchron-agent-chat": {
      configured:
        isAiCoreConfigured() && isMemoryBackendConfigured(process.env),
      authenticated: true,
    },
    "synchron-integrations-status": {
      configured: true,
      authenticated: true,
    },
    "synchron-system-inspector": {
      configured: true,
      authenticated: true,
    },
    "github-read": {
      configured: true,
      authenticated: true,
    },
    "github-write": {
      configured:
        isGitHubOAuthConfigured() &&
        Boolean(
          process.env.OPENAI_API_KEY &&
            process.env.GEMINI_API_KEY &&
            process.env.GROK_API_KEY,
        ),
      authenticated: githubAuthenticated,
      runtimeEnabled: true,
      availabilityCode: null,
      availabilityReason: null,
    },
    "github-confirmed-write": {
      configured: isGitHubOAuthConfigured(),
      authenticated: githubAuthenticated,
    },
    "google-drive-read": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "google-calendar-read": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "google-calendar-write": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "gmail-read": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "google-contacts": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "synchron-tasks": {
      configured: isPersistenceBackendConfigured(process.env),
      authenticated: true,
    },
    "openai-web-search": {
      configured: Boolean(process.env.OPENAI_API_KEY),
    },
    "openai-codex": {
      configured: isCodexAgentConfigured(),
      runtimeEnabled:
        String(process.env.CODEX_AGENT_ENABLED || "").toLowerCase() !== "false",
      availabilityCode:
        String(process.env.CODEX_AGENT_ENABLED || "").toLowerCase() === "false"
          ? "CODEX_AGENT_DISABLED"
          : null,
      availabilityReason:
        String(process.env.CODEX_AGENT_ENABLED || "").toLowerCase() === "false"
          ? "Codex агентът е изключен от конфигурацията."
          : null,
    },
    "google-cloud-read": {
      configured: googleCloud.configured,
      authenticated: true,
      liveVerified: googleCloud.cloudRunDetected,
      availabilityCode: googleCloud.configured
        ? googleCloud.cloudRunDetected
          ? null
          : "GOOGLE_CLOUD_RUNTIME_NOT_DETECTED"
        : "GOOGLE_CLOUD_NOT_CONFIGURED",
      availabilityReason:
        googleCloud.configured && !googleCloud.cloudRunDetected
          ? "Google Cloud project е конфигуриран, но процесът не е потвърден като Cloud Run runtime."
          : null,
    },
    "google-cloud-write": {
      configured: googleCloud.configured,
      authenticated: true,
      liveVerified: googleCloud.cloudRunDetected,
      availabilityCode: googleCloud.configured
        ? googleCloud.cloudRunDetected
          ? null
          : "GOOGLE_CLOUD_RUNTIME_NOT_DETECTED"
        : "GOOGLE_CLOUD_NOT_CONFIGURED",
      availabilityReason:
        googleCloud.configured && !googleCloud.cloudRunDetected
          ? "Google Cloud project е конфигуриран, но процесът не е потвърден като Cloud Run runtime."
          : null,
    },
    "google-firestore-memory": {
      configured: isMemoryBackendConfigured(process.env),
    },
  };

  return {
    status: "ok",
    ...getRuntimeVersion(),
    core: {
      chatAgent: {
        ...getAiProviderStatus(),
      },
      openai: {
        configured: Boolean(process.env.OPENAI_API_KEY),
      },
      memory: {
        ...configuration["google-firestore-memory"],
      backend:
        resolveMemoryBackend(process.env) === "firestore"
          ? "firestore"
          : null,
      },
    },
    tools: listTools().map((tool) => {
      const toolConfiguration = configuration[tool.id] || {};
      return {
        id: tool.id,
        name: tool.name,
        enabled: tool.enabled && toolConfiguration.runtimeEnabled !== false,
        executable: isToolExecutable(tool.id),
        configured: Boolean(toolConfiguration.configured),
        authenticated: toolConfiguration.authenticated,
        healthStatus: resolveToolHealthStatus(tool, toolConfiguration),
        availabilityCode: toolConfiguration.availabilityCode || null,
        availabilityReason: toolConfiguration.availabilityReason || null,
      };
    }),
  };
}

router.get("/integrations", async (req, res) => {
  try {
    const githubCookies = parseGitHubCookies(req.headers.cookie);
    const session = await getGitHubSession(githubCookies.synchron_github_session);
    const githubAuthenticated = Boolean(
      session && isAuthorizedGitHubLogin(session.login),
    );
    const googleSessionId =
      parseGoogleCookies(req.headers.cookie).synchron_google_session || "";
    const googleConnected = googleSessionId
      ? await hasGoogleSession(googleSessionId)
      : false;
    const liveReport = await getLiveIntegrationReport({
      githubSession: githubAuthenticated ? session : null,
      googleSessionId: googleConnected ? googleSessionId : "",
    });
    res.json(getIntegrationStatus({ liveReport }));
  } catch (error) {
    logSafeError("[Health integrations] Live status failed", error);
    res.status(503).json({
      status: "degraded",
      errorCode: safeErrorCode(error, "INTEGRATION_STATUS_FAILED"),
      safety: {
        readOnly: true,
        secretsDisplayed: false,
        writesExecuted: false,
      },
    });
  }
});

export default router;
