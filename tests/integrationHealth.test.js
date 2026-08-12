import assert from "node:assert/strict";
import test from "node:test";

import { getIntegrationStatus } from "../src/routes/health.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

test("integration status reports Google Cloud runtime without secret values", () => {
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.MEMORY_BACKEND = "firestore";
  process.env.PERSISTENCE_BACKEND = "firestore";
  process.env.GOOGLE_CLOUD_PROJECT = "handy-boulevard-479120-q9";
  process.env.FIRESTORE_DATABASE_ID = "(default)";
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus();
    assert.equal(status.core.memory.backend, "firestore");
    assert.equal(status.core.memory.configured, true);
    assert.equal(status.tools.some((tool) => /opensearch|supabase|digitalocean|cloudflare/u.test(tool.id)), false);
    assert.doesNotMatch(JSON.stringify(status), /openai-secret|handy-boulevard-479120-q9/u);
  } finally {
    for (const key of ["OPENAI_API_KEY", "MEMORY_BACKEND", "PERSISTENCE_BACKEND", "GOOGLE_CLOUD_PROJECT", "FIRESTORE_DATABASE_ID"]) delete process.env[key];
    resetToolRegistryForTests();
  }
});

test("GitHub write remains explicit and disabled unless Copilot is enabled", () => {
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  delete process.env.COPILOT_AUTOMATION_ENABLED;
  resetToolRegistryForTests();
  try {
    const status = getIntegrationStatus({ githubAuthenticated: true });
    const write = status.tools.find((tool) => tool.id === "github-write");
    assert.equal(write.enabled, false);
    assert.equal(write.availabilityCode, "COPILOT_AUTOMATION_DISABLED");
  } finally {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    resetToolRegistryForTests();
  }
});
