import assert from "node:assert/strict";
import test from "node:test";

import {
  getLiveIntegrationReport,
} from "../src/services/liveIntegrationStatusService.js";

function response(payload = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

const githubEnv = Object.freeze({
  GITHUB_API_URL: "https://github.test",
  GITHUB_REPOSITORY: "radostinvgeorgiev-commits/sunchron-backend",
});

test("live report verifies authenticated GitHub and AI provider reads without secrets", async () => {
  const secretValues = [
    "github-token-that-must-not-leak",
    "openai-key-that-must-not-leak",
    "gemini-key-that-must-not-leak",
    "grok-key-that-must-not-leak",
  ];
  const report = await getLiveIntegrationReport({
    env: {
      ...githubEnv,
      GITHUB_TOKEN: secretValues[0],
      OPENAI_API_KEY: secretValues[1],
      GEMINI_API_KEY: secretValues[2],
      GROK_API_KEY: secretValues[3],
    },
    fetchImpl: async () => response({}),
    now: () => new Date("2026-08-23T00:00:00.000Z"),
  });

  assert.equal(report.checkedAt, "2026-08-23T00:00:00.000Z");
  assert.equal(report.tools["github-read"].liveVerified, true);
  assert.equal(report.tools["github-read"].authenticationStatus, "authenticated");
  assert.equal(report.tools["openai-web-search"].liveVerified, true);
  assert.equal(report.tools["openai-codex"].liveVerified, true);
  assert.equal(report.safety.secretsDisplayed, false);
  for (const secret of secretValues) {
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, "u"));
  }
});

test("GitHub Code Write requires live AI dependencies while confirmed writes stay independent", async () => {
  const report = await getLiveIntegrationReport({
    env: {
      ...githubEnv,
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
      GROK_API_KEY: "grok-key",
    },
    githubSession: {
      accessToken: "github-session-token",
      login: "radostinvgeorgiev-commits",
    },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("github.test/user")) {
        return response({ login: "radostinvgeorgiev-commits" });
      }
      if (target.includes("github.test/repos/")) return response({});
      if (target.includes("api.openai.com/v1/models")) return response({});
      if (target.includes("generativelanguage.googleapis.com")) return response({});
      if (target.includes("api.x.ai/v1/models")) return response({}, 503);
      return response({});
    },
  });

  assert.equal(report.tools["github-confirmed-write"].liveVerified, true);
  assert.equal(report.tools["github-write"].liveVerified, false);
  assert.equal(
    report.tools["github-write"].availabilityCode,
    "GITHUB_WRITE_GROK_LIVE_CHECK_FAILED",
  );
  assert.equal(report.tools["github-write"].httpStatus, 503);
});

test("live report maps GitHub 401, 403 and 404 to honest authentication states", async () => {
  for (const [status, authenticationStatus] of [
    [401, "requires_connection"],
    [403, "no_access"],
    [404, "no_access"],
  ]) {
    const report = await getLiveIntegrationReport({
      env: { ...githubEnv, GITHUB_TOKEN: "invalid-token" },
      fetchImpl: async () => response({}, status),
    });
    const github = report.tools["github-read"];
    assert.equal(github.liveVerified, false);
    assert.equal(github.healthStatus, "degraded");
    assert.equal(github.httpStatus, status);
    assert.equal(github.availabilityCode, `HTTP_${status}`);
    assert.equal(github.authenticationStatus, authenticationStatus);
    assert.equal(github.smokeTest.status, "failed");
  }
});

test("live report exposes timeout failures instead of claiming a working adapter", async () => {
  const report = await getLiveIntegrationReport({
    env: githubEnv,
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  const github = report.tools["github-read"];
  assert.equal(github.liveVerified, false);
  assert.equal(github.healthStatus, "degraded");
  assert.equal(github.availabilityCode, "LIVE_CHECK_TIMEOUT");
  assert.equal(github.smokeTest.errorCode, "LIVE_CHECK_TIMEOUT");
});

test("live report verifies Cloud Run diagnostics and keeps revision and commit in the read result", async () => {
  const report = await getLiveIntegrationReport({
    env: {
      GOOGLE_CLOUD_PROJECT: "project-1",
      K_SERVICE: "synchron-backend-google",
      K_REVISION: "synchron-backend-google-00055-85g",
    },
    fetchImpl: async () => response({}),
    diagnostics: async () => ({
      status: "pass",
      runtime: {
        service: "synchron-backend-google",
        revision: "synchron-backend-google-00055-85g",
        commit: "commit-1",
      },
      checks: {
        publicHealth: { status: "pass", httpStatus: 200 },
        readiness: { status: "pass", httpStatus: 200 },
        cloudRun: { status: "pass", httpStatus: 200 },
        cloudBuildLatest: { status: "pass", httpStatus: 200 },
      },
    }),
  });

  assert.equal(report.tools["google-cloud-read"].liveVerified, true);
  assert.equal(report.tools["google-cloud-diagnostics"].liveVerified, true);
  assert.equal(report.tools["google-cloud-write"].liveVerified, true);
  assert.equal(report.dependencies.cloudRun.liveVerified, true);
  assert.equal(report.dependencies.cloudBuild.liveVerified, true);
  assert.equal(report.googleCloud.diagnostics.runtime.revision, "synchron-backend-google-00055-85g");
  assert.equal(report.googleCloud.diagnostics.runtime.commit, "commit-1");
});

test("live report checks Identity Platform through the runtime service identity", async () => {
  const report = await getLiveIntegrationReport({
    env: {
      IDENTITY_PLATFORM_PROJECT_ID: "project-1",
      IDENTITY_PLATFORM_API_KEY: "identity-api-key-1234567890",
    },
    fetchImpl: async (url) => {
      if (url ===
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") {
        return response({ access_token: "runtime-token" });
      }
      if (url.includes("/admin/v2/projects/project-1/config")) {
        return response({ name: "projects/project-1/config" });
      }
      return response({});
    },
  });

  assert.equal(report.dependencies.identityPlatform.liveVerified, true);
  assert.equal(
    report.dependencies.identityPlatform.authenticationStatus,
    "authenticated",
  );
  assert.doesNotMatch(JSON.stringify(report), /runtime-token/u);
});

test("live report requires a real session for Google adapters and MCP", async () => {
  const report = await getLiveIntegrationReport({
    env: {
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "https://example.test/callback",
      MCP_OAUTH_SECRET: "mcp-oauth-secret-that-is-long-enough",
      MCP_RESOURCE_URL: "https://mcp.example.test",
    },
    fetchImpl: async () => response({}),
  });

  for (const id of [
    "google-drive-read",
    "google-calendar-read",
    "gmail-read",
    "google-contacts",
  ]) {
    assert.equal(report.tools[id].configured, true, id);
    assert.equal(
      report.tools[id].authenticationStatus,
      "requires_connection",
      id,
    );
    assert.equal(report.tools[id].liveVerified, false, id);
  }
  assert.equal(report.tools.mcp.authenticationStatus, "requires_connection");
  assert.equal(report.tools.mcp.liveVerified, false);
});
