import express from "express";
import { getOpenSearchClient } from "../config/opensearch.js";
import { resolveRuntimeVersion } from "../config/runtimeVersion.js";
import {
  getGitHubSession,
  isAuthorizedGitHubLogin,
  isGitHubOAuthConfigured,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import { createMcpRequestHandler } from "../services/mcpReadService.js";
import { isToolExecutable } from "../tools/capabilityEngine.js";
import { listTools, registerCoreTools } from "../tools/toolRegistry.js";

const router = express.Router();
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

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

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
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
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  const digitalOceanAgentReady = hasAllEnvironmentVariables(
    env,
    "AGENT_URL",
    "AGENT_KEY",
  );
  const openAiReady = Boolean(env.OPENAI_API_KEY);
  const chatAgentReady = openAiReady || digitalOceanAgentReady;
  let memory = { ready: false, status: "unavailable" };

  try {
    const client = loadOpenSearchClient();
    if (client) {
      const response = await withTimeout(client.cluster.health(), timeoutMs);
      const clusterStatus = response?.body?.status || response?.status;
      memory = {
        ready: Boolean(clusterStatus) && clusterStatus !== "red",
        status: clusterStatus || "unknown",
      };
    }
  } catch {
    memory = { ready: false, status: "unavailable" };
  }

  const bridge = (
    await getBridgeDiagnosticsStatus({ env, timeoutMs })
  ).bridge;
  const ready = chatAgentReady && memory.ready;
  return {
    status: ready ? "ready" : "not-ready",
    ...getRuntimeVersion(env),
    checks: {
      chatAgent: {
        ready: chatAgentReady,
        status: chatAgentReady ? "configured" : "not-configured",
        primaryProvider: openAiReady
          ? "openai"
          : digitalOceanAgentReady
            ? "digitalocean"
            : null,
        fallbackConfigured: openAiReady && digitalOceanAgentReady,
      },
      memory,
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

export async function getBridgeDiagnosticsStatus({
  env = process.env,
  handleMcpRequest = createMcpRequestHandler(),
  timeoutMs = 1_000,
} = {}) {
  const configured =
    typeof env.MCP_ACCESS_TOKEN === "string" &&
    env.MCP_ACCESS_TOKEN.length >= 32;
  let responding = false;

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
      readOnly: true,
      tools: 4,
      authentication: {
        mode: "static-bearer",
        chatgptOAuthReady: false,
        reason: "oauth-2.1-authorization-server-required",
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
  if (!tool.enabled || !configuration.configured) return "unavailable";
  if (configuration.authenticated === false) return "degraded";
  return "healthy";
}

export function getIntegrationStatus({ githubAuthenticated = false } = {}) {
  registerCoreTools();
  const configuration = {
    "github-read": {
      configured: true,
      authenticated: true,
    },
    "github-write": {
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
    "gmail-read": {
      configured: hasAllProcessEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
      authenticated: false,
    },
    "openai-web-search": {
      configured: Boolean(process.env.OPENAI_API_KEY),
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
          process.env.DIGITALOCEAN_API_TOKEN ||
            process.env.DIGITALOCEAN_TOKEN,
        ) && Boolean(process.env.DIGITALOCEAN_APP_ID),
    },
    "cloudflare-read": {
      configured:
        Boolean(process.env.CLOUDFLARE_API_TOKEN) &&
        Boolean(process.env.CLOUDFLARE_ZONE_ID),
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
        configured:
          Boolean(process.env.OPENAI_API_KEY) ||
          hasAllProcessEnvironmentVariables("AGENT_URL", "AGENT_KEY"),
        primaryProvider: process.env.OPENAI_API_KEY
          ? "openai"
          : hasAllProcessEnvironmentVariables("AGENT_URL", "AGENT_KEY")
            ? "digitalocean"
            : null,
        fallbackConfigured:
          Boolean(process.env.OPENAI_API_KEY) &&
          hasAllProcessEnvironmentVariables("AGENT_URL", "AGENT_KEY"),
      },
      openai: {
        configured: Boolean(process.env.OPENAI_API_KEY),
      },
      memory: configuration["opensearch-memory"],
    },
    tools: listTools().map((tool) => ({
      id: tool.id,
      name: tool.name,
      enabled: tool.enabled,
      executable: isToolExecutable(tool.id),
      configured: Boolean(configuration[tool.id]?.configured),
      authenticated: configuration[tool.id]?.authenticated,
      healthStatus: resolveToolHealthStatus(tool, configuration[tool.id]),
    })),
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
