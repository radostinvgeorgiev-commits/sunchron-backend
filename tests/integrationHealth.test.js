import assert from "node:assert/strict";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "MEMORY_BACKEND",
  "PERSISTENCE_BACKEND",
  "GOOGLE_CLOUD_PROJECT",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
];

test("integration status exposes Google Cloud and the three-engine code council without secrets", () => {
  const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) process.env[key] = `secret-${key}`;
  process.env.MEMORY_BACKEND = "firestore";
  process.env.PERSISTENCE_BACKEND = "firestore";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    assert.equal(status.core.chatAgent.configured, true);
    assert.equal(status.core.memory.backend, "firestore");
    assert.equal(status.tools.length, 16);
    const codeWrite = status.tools.find(({ id }) => id === "github-write");
    assert.equal(codeWrite.configured, true);
    assert.equal(codeWrite.authenticated, true);
    assert.equal(codeWrite.healthStatus, "healthy");
    const cloud = status.tools.find(({ id }) => id === "google-cloud-read");
    assert.equal(cloud.configured, true);
    assert.doesNotMatch(JSON.stringify(status), /secret-/u);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});

test("AI CORE Code Write is unavailable unless all three engines are configured", () => {
  const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = "openai";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROK_API_KEY;
  process.env.GITHUB_CLIENT_ID = "client";
  process.env.GITHUB_CLIENT_SECRET = "secret";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const codeWrite = status.tools.find(({ id }) => id === "github-write");
    assert.equal(codeWrite.configured, false);
    assert.equal(codeWrite.healthStatus, "unavailable");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});
