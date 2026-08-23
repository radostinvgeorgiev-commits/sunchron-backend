import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProjectDiagnostics,
  getProjectDiagnostics,
} from "../src/services/projectDiagnosticsService.js";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("project diagnostics checks public runtime, MCP, Cloud Run and trigger without secrets", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/health")) {
      return response({ status: "ok", commit: "commit-1" });
    }
    if (url.endsWith("/health/ready")) {
      return response({
        status: "ready",
        commit: "commit-1",
        reachable: true,
        responding: true,
        tools: 48,
      });
    }
    if (url.endsWith("/mcp")) {
      return response({
        result: {
          tools: [
            { name: "get_google_cloud_project_diagnostics" },
            { name: "confirm_google_cloud_action" },
          ],
        },
      });
    }
    if (url.includes("run.googleapis.com")) {
      return response({
        name: "projects/project-1/locations/europe-west1/services/synchron-backend-google",
        latestReadyRevision:
          "projects/project-1/locations/europe-west1/services/synchron-backend-google/revisions/synchron-backend-google-00055-85g",
        latestCreatedRevision:
          "projects/project-1/locations/europe-west1/services/synchron-backend-google/revisions/synchron-backend-google-00056-abc",
        template: { containers: [{ image: "image@sha256:redacted" }] },
        annotations: { "synchron-x/app-commit-sha": "commit-1" },
      });
    }
    if (url.includes("cloudbuild.googleapis.com")) {
      if (url.includes("/builds?")) {
        return response({
          builds: [
            {
              id: "build-older",
              status: "FAILURE",
              createTime: "2026-08-22T23:00:00.000Z",
              substitutions: { COMMIT_SHA: "old-commit" },
            },
            {
              id: "build-newer",
              status: "SUCCESS",
              createTime: "2026-08-23T00:00:00.000Z",
              substitutions: { COMMIT_SHA: "commit-1" },
            },
          ],
        });
      }
      return response({
        name: "projects/project-1/locations/global/triggers/trigger-1",
        github: { push: { branch: "^main$" } },
        serviceAccount: "ai-core-admin@project-1.iam.gserviceaccount.com",
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const report = await getProjectDiagnostics({
    env: {
      GOOGLE_CLOUD_PROJECT: "project-1",
      CLOUD_RUN_SERVICE: "synchron-backend-google",
      GOOGLE_CLOUD_REGION: "europe-west1",
      CLOUD_BUILD_TRIGGER_ID: "trigger-1",
      APP_COMMIT_SHA: "commit-1",
      PUBLIC_ORIGIN: "https://cloudaicore.com",
    },
    fetchImpl,
    accessTokenProvider: async () => "secret-token-must-not-appear",
    now: () => "2026-08-23T00:00:00.000Z",
  });

  assert.equal(report.status, "pass");
  assert.equal(report.commit.matchesExpected, true);
  assert.equal(report.checks.cloudRun.latestReadyRevision, "synchron-backend-google-00055-85g");
  assert.equal(report.checks.cloudRun.latestCreatedRevision, "synchron-backend-google-00056-abc");
  assert.equal(report.checks.cloudRun.service, "synchron-backend-google");
  assert.equal(report.checks.cloudRun.image, "image@sha256:redacted");
  assert.equal(report.checks.cloudRun.appCommit, "commit-1");
  assert.equal(report.checks.cloudBuildTrigger.branch, "^main$");
  assert.equal(report.checks.cloudBuildLatest.build.id, "build-newer");
  assert.equal(report.checks.cloudBuildLatest.build.status, "SUCCESS");
  assert.equal(
    requests.find(({ url }) => url.includes("run.googleapis.com"))?.url,
    "https://run.googleapis.com/v2/projects/project-1/locations/europe-west1/services/synchron-backend-google",
  );
  const cloudBuildListUrl = requests.find(({ url }) => url.includes("/builds?"))?.url;
  assert.equal(
    cloudBuildListUrl,
    "https://cloudbuild.googleapis.com/v1/projects/project-1/builds?pageSize=10",
  );
  assert.equal(cloudBuildListUrl.includes("orderBy"), false);
  assert.equal(report.safety.secretsDisplayed, false);
  assert.equal(formatProjectDiagnostics(report).includes("secret-token"), false);
  assert.equal(JSON.stringify(report).includes("secret-token"), false);
});

test("project diagnostics is partial and safe when Cloud identity is unavailable", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return response({ status: "ok", commit: "commit-1" });
    if (url.endsWith("/health/ready")) return response({ status: "ready", commit: "commit-1" });
    if (url.endsWith("/mcp")) return response({ result: { tools: [{ name: "safe_tool" }] } });
    throw new Error("Cloud API should not be called when token is unavailable");
  };
  const report = await getProjectDiagnostics({
    env: { GOOGLE_CLOUD_PROJECT: "project-1" },
    fetchImpl,
    accessTokenProvider: async () => {
      const error = new Error("no identity");
      error.code = "GOOGLE_CLOUD_TOKEN_UNAVAILABLE";
      throw error;
    },
  });
  assert.equal(report.status, "partial");
  assert.equal(report.checks.cloudRun.status, "unavailable");
  assert.equal(report.checks.cloudBuildTrigger.errorCode, "GOOGLE_CLOUD_TOKEN_UNAVAILABLE");
  assert.equal(report.safety.arbitraryCommands, false);
});
