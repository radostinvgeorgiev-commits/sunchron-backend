import express from "express";
import { getOpenSearchClient } from "../config/opensearch.js";
import { isGitHubOAuthConfigured } from "../services/githubOAuthService.js";
import { isToolExecutable } from "../tools/capabilityEngine.js";
import { listTools, registerCoreTools } from "../tools/toolRegistry.js";

const router = express.Router();
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export function getRuntimeVersion(env = process.env) {
  return {
    version: env.npm_package_version || "1.0.0",
    commit: env.APP_COMMIT_SHA || "unknown",
  };
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
  const chatAgentReady = hasAllEnvironmentVariables(
    env,
    "AGENT_URL",
    "AGENT_KEY",
  );
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

  const ready = chatAgentReady && memory.ready;
  return {
    status: ready ? "ready" : "not-ready",
    ...getRuntimeVersion(env),
    checks: {
      chatAgent: {
        ready: chatAgentReady,
        status: chatAgentReady ? "configured" : "not-configured",
      },
      memory,
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

function hasAllProcessEnvironmentVariables(...names) {
  return hasAllEnvironmentVariables(process.env, ...names);
}

function resolveToolHealthStatus(tool, configuration = {}) {
  if (!tool.enabled || !configuration.configured) return "unavailable";
  if (configuration.authenticated === false) return "degraded";
  return "healthy";
}

export function getIntegrationStatus() {
  registerCoreTools();
  const configuration = {
    "github-read": {
      configured: true,
      authenticated: true,
    },
    "github-write": {
      configured: isGitHubOAuthConfigured(),
      authenticated: false,
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
        configured: hasAllProcessEnvironmentVariables("AGENT_URL", "AGENT_KEY"),
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

router.get("/integrations", (req, res) => {
  res.json(getIntegrationStatus());
});

export default router;
