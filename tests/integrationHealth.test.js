import assert from "node:assert/strict";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

const KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "ANTHROPIC_API_KEY",
  "MEMORY_BACKEND",
  "PERSISTENCE_BACKEND",
  "GOOGLE_CLOUD_PROJECT",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "VERTEX_AI_ENABLED",
  "VERTEX_AI_PROJECT_ID",
  "VERTEX_AI_LOCATION",
  "VERTEX_AI_MODEL",
];

test("integration status exposes Google Cloud and Vertex code readiness without secrets", () => {
  const original = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of KEYS) process.env[key] = `secret-${key}`;
  process.env.MEMORY_BACKEND = "firestore";
  process.env.PERSISTENCE_BACKEND = "firestore";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    assert.equal(status.core.chatAgent.configured, true);
    assert.deepEqual(
      status.core.chatAgent.providers.find(({ id }) => id === "vertex-gemini"),
      { id: "vertex-gemini", configured: false },
    );
    assert.equal(status.core.memory.backend, "firestore");
    assert.equal(status.tools.length, 22);
    const codeWrite = status.tools.find(({ id }) => id === "github-write");
    assert.equal(codeWrite.configured, false);
    assert.equal(codeWrite.authenticated, true);
    assert.equal(codeWrite.healthStatus, "unavailable");
    const cloud = status.tools.find(({ id }) => id === "google-cloud-read");
    assert.equal(cloud.configured, true);
    const cloudWrite = status.tools.find(
      ({ id }) => id === "google-cloud-write",
    );
    assert.equal(cloudWrite.configured, true);
    assert.equal(cloudWrite.healthStatus, "degraded");
    assert.doesNotMatch(JSON.stringify(status), /secret-/u);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});

test("NovariumAI Code Write requires Vertex Gemini configuration", () => {
  const original = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.VERTEX_AI_ENABLED = "true";
  process.env.VERTEX_AI_PROJECT_ID = "novarium-test-12345";
  process.env.VERTEX_AI_LOCATION = "us-central1";
  process.env.VERTEX_AI_MODEL = "gemini-2.5-flash";
  process.env.GITHUB_CLIENT_ID = "client";
  process.env.GITHUB_CLIENT_SECRET = "secret";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const codeWrite = status.tools.find(({ id }) => id === "github-write");
    assert.equal(codeWrite.configured, true);
    assert.equal(codeWrite.healthStatus, "healthy");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});
