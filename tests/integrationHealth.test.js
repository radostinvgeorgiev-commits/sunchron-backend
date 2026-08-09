import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const ENV_NAMES = [
  "OPENAI_API_KEY",
  "AI_CORE_PROVIDER",
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_AGENT_ENABLED",
  "OPENSEARCH_HOST",
  "OPENSEARCH_PORT",
  "OPENSEARCH_USERNAME",
  "OPENSEARCH_PASSWORD",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "COPILOT_AUTOMATION_ENABLED",
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
  process.env.AI_CORE_PROVIDER = "openai";
  process.env.COPILOT_AUTOMATION_ENABLED = "true";
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus();
    assert.equal(status.core.chatAgent.configured, true);
    assert.equal(status.core.chatAgent.primaryProvider, "openai");
    assert.equal(status.core.chatAgent.removedProvider, "digitalocean-agent");
    assert.equal(status.core.openai.configured, true);
    assert.equal(status.tools.length, 18);
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
    const codex = status.tools.find((tool) => tool.id === "openai-codex");
    assert.equal(codex.enabled, true);
    assert.equal(codex.executable, true);
    assert.equal(codex.configured, true);
    assert.equal(codex.healthStatus, "healthy");
    const cloudflare = status.tools.find(
      (tool) => tool.id === "cloudflare-read",
    );
    assert.equal(cloudflare.configured, true);
    assert.equal(cloudflare.healthStatus, "degraded");
    assert.equal(cloudflare.availabilityCode, "CLOUDFLARE_LIVE_CHECK_REQUIRED");
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
  process.env.COPILOT_AUTOMATION_ENABLED = "true";
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const githubWrite = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(githubWrite.configured, true);
    assert.equal(githubWrite.authenticated, true);
    assert.equal(githubWrite.healthStatus, "healthy");
    const confirmedWrite = status.tools.find(
      (tool) => tool.id === "github-confirmed-write",
    );
    assert.equal(confirmedWrite.configured, true);
    assert.equal(confirmedWrite.authenticated, true);
    assert.equal(confirmedWrite.healthStatus, "healthy");
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
  process.env.COPILOT_AUTOMATION_ENABLED = "true";
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

test("GitHub Write reports the explicit mode without Copilot", () => {
  const original = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  delete process.env.COPILOT_AUTOMATION_ENABLED;
  resetToolRegistryForTests();

  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const githubWrite = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(githubWrite.enabled, false);
    assert.equal(githubWrite.executable, false);
    assert.equal(githubWrite.configured, true);
    assert.equal(githubWrite.healthStatus, "unavailable");
    assert.equal(githubWrite.availabilityCode, "COPILOT_AUTOMATION_DISABLED");
    assert.match(githubWrite.availabilityReason, /режим без Copilot/u);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetToolRegistryForTests();
  }
});

test("removed DigitalOcean AI Agent is not required by production configuration", async () => {
  const [appSpec, server, identity, envExample] = await Promise.all([
    readFile(new URL("../.do/app.yaml", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/config/projectIdentity.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(appSpec, /key:\s*AGENT_(?:URL|KEY)/u);
  assert.doesNotMatch(server, /if\s*\(!process\.env\.AGENT_KEY\)/u);
  assert.match(server, /if\s*\(!process\.env\.OPENAI_API_KEY\)/u);
  assert.doesNotMatch(identity, /DigitalOcean Agent е резервният AI/u);
  assert.match(identity, /DigitalOcean Agent е премахнат/u);
  assert.doesNotMatch(envExample, /^AGENT_(?:URL|KEY)=/mu);
});

test("project identity keeps one capability-based integration policy", async () => {
  const identity = await import("../src/config/projectIdentity.js");

  assert.match(
    identity.INTEGRATION_POLICY,
    /Tool Registry, изпълнимият адаптер, конфигурацията и реална заявка/u,
  );
  assert.match(identity.INTEGRATION_POLICY, /добавя чрез Capability Engine/u);
  assert.match(
    identity.INTEGRATION_POLICY,
    /Не се създава отделен тунел, worker или втори deployment/u,
  );
  assert.ok(
    identity.PROJECT_BASE_CONTEXT.includes(identity.INTEGRATION_POLICY),
  );
  assert.equal("BRIDGE_FIRST_POLICY" in identity, false);
});
