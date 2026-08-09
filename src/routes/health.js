import express from "express";
import { getOpenSearchClient } from "../config/opensearch.js";
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
import { isCopilotAutomationEnabled } from "../config/featureFlags.js";
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

const router = express.Router();
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_BACKUP_ROUTE_TIMEOUT_MS = 10_000;
const DEFAULT_OPENSEARCH_BACKUP_MAX_AGE_HOURS = 48;
const MAX_VERIFIED_BACKUP_CACHE_TTL_MS = 6 * 60 * 60_000;
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
  report,
  {
    now = () => Date.now(),
    maxAgeHours = process.env.OPENSEARCH_BACKUP_MAX_AGE_HOURS,
  } = {},
) {
  const backup = report?.checks?.opensearch;
  if (backup?.status !== "verified" || backup?.fresh !== true) {
    return FAILED_BACKUP_CACHE_TTL_MS;
  }

  const newestTimestamp = Date.parse(backup.newestCreatedAt);
  const parsedMaxAgeHours = Number.parseInt(maxAgeHours, 10);
  const boundedMaxAgeHours =
    Number.isFinite(parsedMaxAgeHours) && parsedMaxAgeHours > 0
      ? parsedMaxAgeHours
      : DEFAULT_OPENSEARCH_BACKUP_MAX_AGE_HOURS;
  if (!Number.isFinite(newestTimestamp)) return FAILED_BACKUP_CACHE_TTL_MS;

  const remainingFreshnessMs =
    newestTimestamp + boundedMaxAgeHours * 60 * 60_000 - now();
  return Math.max(
    1,
    Math.min(MAX_VERIFIED_BACKUP_CACHE_TTL_MS, remainingFreshnessMs),
  );
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
  loadOpenSearchClient = getOpenSearchClient,
  loadMemoryVerificationStatus = getMemoryStartupVerificationStatus,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  const aiProviderStatus = getAiProviderStatus(env);
  const chatAgentReady = aiProviderStatus.configured;
  let memory = { ready: false, status: "unavailable" };

  try {
    const client = loadOpenSearchClient();
    if (client) {
      const response = await withTimeout(
        client.cluster.health(
          {},
          { requestTimeout: timeoutMs, maxRetries: 0 },
        ),
        timeoutMs,
      );
      const clusterStatus = response?.body?.status || response?.status;
      memory = {
        ready: Boolean(clusterStatus) && clusterStatus !== "red",
        status: clusterStatus || "unknown",
      };
    }
  } catch {
    memory = { ready: false, status: "unavailable" };
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
        removedProvider: "digitalocean-agent",
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
      opensearch: {
        status: report.checks?.opensearch?.status || "unverified",
        errorCode: report.checks?.opensearch?.errorCode || null,
        fresh: report.checks?.opensearch?.fresh === true,
        readOnlyCheck: true,
        provesRestore: false,
      },
      supabase: {
        status: report.checks?.supabase?.status || "unverified",
        errorCode:
          report.checks?.supabase?.errorCode ||
          "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
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
      opensearch: {
        status: "unverified",
        errorCode: "STORAGE_BACKUP_REPORT_FAILED",
        fresh: false,
        readOnlyCheck: true,
        provesRestore: false,
      },
      supabase: {
        status: "unverified",
        errorCode: "SUPABASE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        readOnlyCheck: true,
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

export function getIntegrationStatus({ githubAuthenticated = false } = {}) {
  registerCoreTools();
  const copilotAutomationEnabled = isCopilotAutomationEnabled();
  const configuration = {
    "synchron-agent-chat": {
      configured:
        isAiCoreConfigured() &&
        hasAllProcessEnvironmentVariables(
          "OPENSEARCH_HOST",
          "OPENSEARCH_PORT",
          "OPENSEARCH_USERNAME",
          "OPENSEARCH_PASSWORD",
        ),
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
      configured: isGitHubOAuthConfigured(),
      authenticated: githubAuthenticated,
      runtimeEnabled: copilotAutomationEnabled,
      availabilityCode: copilotAutomationEnabled
        ? null
        : "COPILOT_AUTOMATION_DISABLED",
      availabilityReason: copilotAutomationEnabled
        ? null
        : "GitHub Write е изключен — режим без Copilot.",
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
      configured: hasAllProcessEnvironmentVariables(
        "OPENSEARCH_HOST",
        "OPENSEARCH_PORT",
        "OPENSEARCH_USERNAME",
        "OPENSEARCH_PASSWORD",
      ),
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
    "supabase-status": {
      configured: hasAllProcessEnvironmentVariables(
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
      ),
    },
    "digitalocean-read": {
      configured:
        Boolean(
          process.env.DIGITALOCEAN_API_TOKEN || process.env.DIGITALOCEAN_TOKEN,
        ) && Boolean(process.env.DIGITALOCEAN_APP_ID),
    },
    "cloudflare-read": {
      configured: Boolean(process.env.CLOUDFLARE_API_TOKEN),
      liveVerified: false,
      availabilityCode: process.env.CLOUDFLARE_API_TOKEN
        ? "CLOUDFLARE_LIVE_CHECK_REQUIRED"
        : null,
      availabilityReason: process.env.CLOUDFLARE_API_TOKEN
        ? "Cloudflare е конфигуриран, но тази справка не е жива API проверка."
        : null,
    },
    "opensearch-memory": {
      configured: hasAllProcessEnvironmentVariables(
        "OPENSEARCH_HOST",
        "OPENSEARCH_PORT",
        "OPENSEARCH_USERNAME",
        "OPENSEARCH_PASSWORD",
      ),
    },
  };

  return {
    status: "ok",
    ...getRuntimeVersion(),
    core: {
      chatAgent: {
        ...getAiProviderStatus(),
        removedProvider: "digitalocean-agent",
      },
      openai: {
        configured: Boolean(process.env.OPENAI_API_KEY),
      },
      memory: configuration["opensearch-memory"],
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
  const cookies = parseGitHubCookies(req.headers.cookie);
  const session = await getGitHubSession(cookies.synchron_github_session);
  const githubAuthenticated = Boolean(
    session && isAuthorizedGitHubLogin(session.login),
  );
  res.json(getIntegrationStatus({ githubAuthenticated }));
});

export default router;
