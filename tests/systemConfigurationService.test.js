import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentInventory,
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "../src/services/systemConfigurationService.js";

test("environment inventory exposes metadata and never values", () => {
  const secretValue = "must-never-be-returned";
  const inventory = buildEnvironmentInventory({
    env: {
      OPENAI_API_KEY: secretValue,
      NODE_ENV: "production",
    },
    digitalOceanVariables: [
      {
        key: "OPENAI_API_KEY",
        type: "SECRET",
        scope: "RUN_TIME",
      },
    ],
  });
  const openAi = inventory.find((item) => item.key === "OPENAI_API_KEY");
  const logicCore = inventory.find((item) => item.key === "LOGIC_CORE_URL");

  assert.equal(openAi.runtimeConfigured, true);
  assert.equal(openAi.digitalOceanDeclared, true);
  assert.equal(openAi.status, "configured");
  assert.equal(logicCore.status, "unused");
  assert.equal(JSON.stringify(inventory).includes(secretValue), false);
});

test("system report tolerates a missing DigitalOcean bridge", async () => {
  const report = await getSystemConfigurationReport({
    env: { NODE_ENV: "production" },
    getDigitalOceanStatus: async () => {
      throw Object.assign(new Error("not configured"), {
        code: "DIGITALOCEAN_NOT_CONFIGURED",
      });
    },
  });

  assert.equal(report.digitalOcean.connected, false);
  assert.equal(report.digitalOcean.errorCode, "DIGITALOCEAN_NOT_CONFIGURED");
  assert.equal(report.secretsExposed, false);
  assert.ok(report.summary.missingRequired > 0);
  assert.match(formatSystemConfigurationReport(report), /не се връщат/u);
});

test("system report merges the live DigitalOcean variable inventory", async () => {
  const report = await getSystemConfigurationReport({
    env: {
      NODE_ENV: "production",
      OPENAI_API_KEY: "configured-secret",
    },
    getDigitalOceanStatus: async () => ({
      id: "app-1",
      name: "sunchron-backend",
      liveUrl: "https://example.test",
      environmentVariables: [
        {
          key: "OPENAI_API_KEY",
          type: "SECRET",
          scope: "RUN_TIME",
        },
      ],
      activeDeployment: { id: "deployment-1", phase: "ACTIVE" },
      inProgressDeployment: null,
    }),
  });

  const openAi = report.environment.find(
    (item) => item.key === "OPENAI_API_KEY",
  );
  assert.equal(report.digitalOcean.connected, true);
  assert.equal(openAi.digitalOceanDeclared, true);
  assert.equal(JSON.stringify(report).includes("configured-secret"), false);
});
