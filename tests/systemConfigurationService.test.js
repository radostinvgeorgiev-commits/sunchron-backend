import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentInventory,
  formatSystemConfigurationReport,
  getProductionReadinessStatus,
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
  const memoryOwner = inventory.find((item) => item.key === "MEMORY_OWNER_ID");

  assert.equal(openAi.runtimeConfigured, true);
  assert.equal(openAi.digitalOceanDeclared, true);
  assert.equal(openAi.status, "configured");
  assert.equal(
    inventory.some((item) => item.key === "LOGIC_CORE_URL"),
    false,
  );
  assert.equal(memoryOwner.status, "defaulted");
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
    getProductionStatus: async () => ({
      connected: true,
      status: "ready",
      commit: "965765f947fb62742a5e5c05a69f22696328ac72",
      memoryAcceptance: {
        ready: true,
        status: "works",
        isolated: true,
        realMemoryUnchanged: true,
        cleanupCompleted: true,
        passedSteps: 9,
      },
      errorCode: null,
    }),
  });

  assert.equal(report.digitalOcean.connected, false);
  assert.equal(report.digitalOcean.errorCode, "DIGITALOCEAN_NOT_CONFIGURED");
  assert.equal(report.secretsExposed, false);
  assert.ok(report.summary.missingRequired > 0);
  assert.match(
    formatSystemConfigurationReport(report),
    /Production \/health\/ready: готово/u,
  );
  assert.match(formatSystemConfigurationReport(report), /9 проверени стъпки/u);
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
    getProductionStatus: async () => ({
      connected: false,
      status: "unavailable",
      commit: null,
      memoryAcceptance: null,
      errorCode: "PRODUCTION_READINESS_UNAVAILABLE",
    }),
  });

  const openAi = report.environment.find(
    (item) => item.key === "OPENAI_API_KEY",
  );
  assert.equal(report.digitalOcean.connected, true);
  assert.equal(openAi.digitalOceanDeclared, true);
  assert.equal(JSON.stringify(report).includes("configured-secret"), false);
});

test("derived tester secrets are reported as protected fallbacks, not missing", () => {
  const inventory = buildEnvironmentInventory({
    env: {
      GITHUB_SESSION_ENCRYPTION_KEY:
        "a-strong-owner-session-secret-that-never-leaves-runtime",
    },
  });
  const session = inventory.find(
    (item) => item.key === "SUPABASE_SESSION_ENCRYPTION_KEY",
  );
  const invite = inventory.find(
    (item) => item.key === "SYNCHRON_TEST_INVITE_CODE",
  );

  assert.equal(session.status, "protected-fallback");
  assert.equal(invite.status, "protected-fallback");
});

test("production readiness keeps only safe proof fields", async () => {
  const report = await getProductionReadinessStatus({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "ready",
        commit: "965765f947fb62742a5e5c05a69f22696328ac72",
        secret: "must-not-survive",
        checks: {
          memoryAcceptance: {
            ready: true,
            status: "works",
            isolated: true,
            realMemoryUnchanged: true,
            cleanupCompleted: true,
            passedSteps: 9,
            privateFact: "must-not-survive",
          },
        },
      }),
    }),
  });

  assert.equal(report.status, "ready");
  assert.equal(report.commit, "965765f947fb62742a5e5c05a69f22696328ac72");
  assert.equal(report.memoryAcceptance.passedSteps, 9);
  assert.doesNotMatch(JSON.stringify(report), /must-not-survive/u);
});
