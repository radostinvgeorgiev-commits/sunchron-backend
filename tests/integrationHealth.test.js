import assert from "node:assert/strict";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const ENV_NAMES = [
  "AGENT_URL",
  "AGENT_KEY",
  "OPENAI_API_KEY",
  "OPENSEARCH_HOST",
  "OPENSEARCH_PORT",
  "OPENSEARCH_USERNAME",
  "OPENSEARCH_PASSWORD",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "DIGITALOCEAN_API_TOKEN",
  "DIGITALOCEAN_APP_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
];

test("integration status reports configuration without exposing secret values", () => {
  const original = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of ENV_NAMES) process.env[name] = `secret-${name}`;
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus();
    assert.equal(status.core.chatAgent.configured, true);
    assert.equal(status.core.openai.configured, true);
    assert.equal(status.tools.length, 10);
    assert.equal(
      status.tools
        .filter((tool) => tool.id !== "github-write")
        .every(
          (tool) => tool.executable && tool.configured && tool.healthStatus,
        ),
      true,
    );
    const githubWrite = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(githubWrite.enabled, true);
    assert.equal(githubWrite.executable, true);
    assert.equal(githubWrite.configured, true);
    assert.equal(githubWrite.authenticated, false);
    assert.equal(githubWrite.healthStatus, "degraded");
    assert.doesNotMatch(JSON.stringify(status), /secret-/u);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetToolRegistryForTests();
  }
});

test("GitHub Write reports the authenticated owner session", () => {
  const original = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const githubWrite = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(githubWrite.configured, true);
    assert.equal(githubWrite.authenticated, true);
    assert.equal(githubWrite.healthStatus, "healthy");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetToolRegistryForTests();
  }
});

test("GitHub Write is configured with client id and secret only", () => {
  const original = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  delete process.env.GITHUB_REDIRECT_URI;
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus();
    const githubWrite = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(githubWrite.configured, true);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetToolRegistryForTests();
  }
});
