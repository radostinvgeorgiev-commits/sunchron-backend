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
    assert.equal(status.tools.length, 6);
    assert.equal(
      status.tools.every(
        (tool) => tool.executable && tool.configured && tool.healthStatus,
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(status), /secret-/u);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetToolRegistryForTests();
  }
});
