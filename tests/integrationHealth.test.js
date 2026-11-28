import assert from "node:assert/strict";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { switchableTools } from "../src/services/toolSwitchService.js";
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
];

test("integration status exposes Google Cloud and the three-engine code council without secrets", () => {
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
    assert.equal(codeWrite.configured, true);
    assert.equal(codeWrite.authenticated, true);
    assert.equal(codeWrite.healthStatus, "healthy");
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

test("NovariumAI Code Write is configured when one engine is available", () => {
  const original = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.OPENAI_API_KEY = "openai";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROK_API_KEY;
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

// Every card in „Инструменти“ reads its state from this list. A tool missing
// here showed as „Не е конфигуриран“ to every person (28.11: „Моите задачи“).
test("every tool a person can switch has its own state, so none shows as not set up by mistake", () => {
  const keys = [
    ...KEYS,
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "NODE_ENV",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `secret-${key}`;
  process.env.MEMORY_BACKEND = "firestore";
  process.env.PERSISTENCE_BACKEND = "firestore";
  process.env.GOOGLE_CLOUD_PROJECT = "novarium-test-project";
  process.env.NODE_ENV = "production";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const byId = new Map(status.tools.map((tool) => [tool.id, tool]));
    for (const identity of [
      { role: "member", memoryOwnerId: "member-b" },
      { role: "owner", memoryOwnerId: "owner-a" },
    ]) {
      for (const tool of switchableTools(identity)) {
        assert.equal(byId.get(tool.id)?.configured, true, `${identity.role}: ${tool.id}`);
      }
    }
    const todos = byId.get("personal-todos");
    assert.equal(todos.configured, true);
    assert.equal(todos.healthStatus, "healthy");
    assert.doesNotMatch(JSON.stringify(status), /secret-/u);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});

test("„Моите задачи“ are set up with the in-process store outside production, and not without a store in production", () => {
  const keys = ["MEMORY_BACKEND", "PERSISTENCE_BACKEND", "GOOGLE_CLOUD_PROJECT", "NODE_ENV"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  resetToolRegistryForTests();
  try {
    process.env.MEMORY_BACKEND = "local";
    process.env.PERSISTENCE_BACKEND = "local";
    delete process.env.GOOGLE_CLOUD_PROJECT;
    process.env.NODE_ENV = "test";
    const local = getIntegrationStatus().tools.find(({ id }) => id === "personal-todos");
    assert.equal(local.configured, true);

    process.env.NODE_ENV = "production";
    const missing = getIntegrationStatus().tools.find(({ id }) => id === "personal-todos");
    assert.equal(missing.configured, false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
});
