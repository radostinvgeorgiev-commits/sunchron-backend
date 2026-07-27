import express from "express";
import { isToolExecutable } from "../tools/capabilityEngine.js";
import { listTools, registerCoreTools } from "../tools/toolRegistry.js";

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ status: "ok", message: "Health check passed" });
});

function hasAllEnvironmentVariables(...names) {
  return names.every((name) => Boolean(process.env[name]));
}

export function getIntegrationStatus() {
  registerCoreTools();
  const configuration = {
    "github-read": {
      configured: true,
      authenticated: Boolean(process.env.GITHUB_TOKEN),
    },
    "github-write": {
      configured: Boolean(process.env.GITHUB_TOKEN),
      authenticated: Boolean(process.env.GITHUB_TOKEN),
    },
    "google-drive-read": {
      configured: hasAllEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
    },
    "google-calendar-read": {
      configured:
        hasAllEnvironmentVariables(
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI",
        ) ||
        hasAllEnvironmentVariables(
          "GOOGLE_CALENDAR_CLIENT_ID",
          "GOOGLE_CALENDAR_CLIENT_SECRET",
          "GOOGLE_CALENDAR_REFRESH_TOKEN",
        ),
    },
    "gmail-read": {
      configured: hasAllEnvironmentVariables(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
      ),
    },
    "openai-web-search": {
      configured: Boolean(process.env.OPENAI_API_KEY),
    },
    "opensearch-memory": {
      configured: hasAllEnvironmentVariables(
        "OPENSEARCH_HOST",
        "OPENSEARCH_PORT",
        "OPENSEARCH_USERNAME",
        "OPENSEARCH_PASSWORD",
      ),
    },
  };

  return {
    status: "ok",
    core: {
      chatAgent: {
        configured: hasAllEnvironmentVariables("AGENT_URL", "AGENT_KEY"),
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
      healthStatus: tool.healthStatus,
    })),
  };
}

router.get("/integrations", (req, res) => {
  res.json(getIntegrationStatus());
});

export default router;
