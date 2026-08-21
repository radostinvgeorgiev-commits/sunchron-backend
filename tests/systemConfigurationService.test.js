import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentInventory,
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "../src/services/systemConfigurationService.js";

test("environment inventory exposes metadata and never values", () => {
  const secret = "must-never-appear";
  const inventory = buildEnvironmentInventory({
    env: {
      OPENAI_API_KEY: secret,
      GOOGLE_CLOUD_PROJECT: "project-1",
    },
  });
  assert.ok(inventory.some(({ key }) => key === "OPENAI_API_KEY"));
  assert.equal(inventory.some((item) => Object.values(item).includes(secret)), false);
  assert.equal(
    inventory.find(({ key }) => key === "OPENAI_API_KEY").source,
    "google-cloud-runtime",
  );
});

test("system report combines Google Cloud runtime and production proof", async () => {
  const report = await getSystemConfigurationReport({
    env: { GOOGLE_CLOUD_PROJECT: "project-1" },
    getGoogleCloudStatus: async () => ({
      provider: "google-cloud",
      configured: true,
      cloudRunDetected: true,
      service: "ai-core",
    }),
    getProductionStatus: async () => ({
      connected: true,
      status: "ready",
      commit: "abc1234",
      memoryAcceptance: null,
      errorCode: null,
    }),
  });
  assert.equal(report.secretsExposed, false);
  assert.equal(report.googleCloud.provider, "google-cloud");
  assert.equal(report.production.status, "ready");
  assert.equal(report.ecosystem.novarium.status, "design");
  assert.equal(report.ecosystem.token.enabled, false);
  assert.equal(report.ecosystem.foundation.enabled, false);
  assert.equal(report.ecosystem.corporation.enabled, false);
  const output = formatSystemConfigurationReport(report);
  assert.match(output, /Google Cloud/u);
  assert.match(output, /NOVARIUM/u);
  assert.match(output, /правен преглед/u);
  assert.doesNotMatch(output, /DigitalOcean|Cloudflare/iu);
});
