import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentInventory,
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "../src/services/systemConfigurationService.js";

const ENV = {
  AUTH_BACKEND: "identity-platform",
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  IDENTITY_PLATFORM_API_KEY: "identity-api-key-1234567890",
  USER_SESSION_ENCRYPTION_KEY: "identity-session-encryption-key",
  MEMORY_BACKEND: "firestore",
  PERSISTENCE_BACKEND: "firestore",
};

test("environment inventory contains only Google Cloud storage and auth backends", () => {
  const inventory = buildEnvironmentInventory({ env: ENV });
  const keys = inventory.map(({ key }) => key);
  assert.equal(keys.includes("MEMORY_BACKEND"), true);
  assert.equal(keys.includes("AUTH_BACKEND"), true);
  assert.equal(keys.some((key) => /OPENSEARCH|SUPABASE|DIGITALOCEAN|CLOUDFLARE/u.test(key)), false);
});

test("system report does not expose secrets or legacy infrastructure", async () => {
  const report = await getSystemConfigurationReport({
    env: ENV,
    getProductionStatus: async () => ({ status: "ready", connected: true, commit: "d74dc51" }),
  });
  const text = formatSystemConfigurationReport(report);
  assert.equal(report.secretsExposed, false);
  assert.match(text, /Google Cloud/u);
  assert.doesNotMatch(text, /DigitalOcean|Cloudflare|OpenSearch|Supabase/u);
});
