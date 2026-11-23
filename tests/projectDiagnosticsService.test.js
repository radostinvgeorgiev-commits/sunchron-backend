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

const inspectHealthyStorage = async () => ({
  checks: { firestore: { status: "healthy", readOnlyCheck: true } },
});

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
    if (new URL(url).hostname === "run.googleapis.com") {
      return response({
        name: "projects/project-1/locations/europe-west1/services/synchron-backend-google",
        latestReadyRevision:
          "projects/project-1/locations/europe-west1/services/synchron-backend-google/revisions/synchron-backend-google-00055-85g",
        latestCreatedRevision:
          "projects/project-1/locations/europe-west1/services/synchron-backend-google/revisions/synchron-backend-google-00056-abc",
        template: {
          containers: [
            {
              image: "image@sha256:redacted",
              env: [
                {
                  valueSource: {
                    secretKeyRef: {
                      secret: "projects/123456789/secrets/private-name",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
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
    if (url.includes("cloudresourcemanager.googleapis.com")) {
      return response({ name: "projects/123456789", state: "ACTIVE" });
    }
    if (url.includes("monitoring.googleapis.com")) {
      const query = new URL(url).searchParams;
      assert.match(query.get("filter"), /run.googleapis.com\/request_count/u);
      assert.match(query.get("filter"), /synchron-backend-google/u);
      assert.equal(query.get("interval.startTime"), "2026-08-22T23:30:00.000Z");
      assert.equal(query.get("view"), "HEADERS");
      return response({ timeSeries: [{ private: "unreported-raw-metric" }] });
    }
    if (url.includes("logging.googleapis.com")) {
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.resourceNames, ["projects/project-1"]);
      assert.equal(body.pageSize, 1);
      assert.match(body.filter, /severity >= ERROR/u);
      return response({ entries: [{ textPayload: "unreported-raw-log" }] });
    }
    if (url.includes("secretmanager.googleapis.com")) {
      assert.equal(options.method, "GET");
      assert.equal(
        url,
        "https://secretmanager.googleapis.com/v1/projects/project-1/secrets/private-name/versions/latest",
      );
      return response({
        state: "ENABLED",
        payload: { data: "unreported-raw-secret" },
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
    inspectStorage: inspectHealthyStorage,
    now: () => "2026-08-23T00:00:00.000Z",
  });

  assert.equal(report.status, "pass");
  assert.equal(report.commit.matchesExpected, true);
  assert.equal(
    report.checks.cloudRun.latestReadyRevision,
    "synchron-backend-google-00055-85g",
  );
  assert.equal(
    report.checks.cloudRun.latestCreatedRevision,
    "synchron-backend-google-00056-abc",
  );
  assert.equal(report.checks.cloudRun.service, "synchron-backend-google");
  assert.equal(report.checks.cloudRun.image, "image@sha256:redacted");
  assert.equal(report.checks.cloudRun.appCommit, "commit-1");
  assert.equal(report.checks.cloudBuildTrigger.branch, "^main$");
  assert.equal(report.checks.cloudBuildLatest.build.id, "build-newer");
  assert.equal(report.checks.cloudBuildLatest.build.status, "SUCCESS");
  assert.equal(report.checks.firestore.status, "pass");
  assert.equal(report.checks.cloudProject.status, "pass");
  assert.equal(report.checks.monitoring.samplePresent, true);
  assert.equal(report.checks.logging.recentErrorFound, true);
  assert.equal(report.checks.secretManager.enabledVersions, 1);
  assert.equal(
    requests.find(({ url }) => new URL(url).hostname === "run.googleapis.com")
      ?.url,
    "https://run.googleapis.com/v2/projects/project-1/locations/europe-west1/services/synchron-backend-google",
  );
  const cloudBuildListUrl = requests.find(({ url }) =>
    url.includes("/builds?"),
  )?.url;
  assert.equal(
    cloudBuildListUrl,
    "https://cloudbuild.googleapis.com/v1/projects/project-1/builds?pageSize=10",
  );
  assert.equal(cloudBuildListUrl.includes("orderBy"), false);
  assert.equal(report.safety.secretsDisplayed, false);
  assert.equal(
    formatProjectDiagnostics(report).includes("secret-token"),
    false,
  );
  assert.equal(JSON.stringify(report).includes("secret-token"), false);
  assert.doesNotMatch(JSON.stringify(report), /unreported-raw|private-name/u);
  requests.length = 0;
  const restricted = await getProjectDiagnostics({
    env: { GOOGLE_CLOUD_PROJECT: "project-1" },
    fetchImpl,
    accessTokenProvider: async () => "test-access",
    inspectStorage: inspectHealthyStorage,
    now: () => "2026-08-23T00:00:00.000Z",
    includeSecretMetadata: false,
  });
  assert.equal(restricted.checks.secretManager, undefined);
  assert.equal(requests.some(({ url }) => url.includes("secretmanager.googleapis.com")), false);
});

test("project diagnostics is partial and safe when Cloud identity is unavailable", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health"))
      return response({ status: "ok", commit: "commit-1" });
    if (url.endsWith("/health/ready"))
      return response({ status: "ready", commit: "commit-1" });
    if (url.endsWith("/mcp"))
      return response({ result: { tools: [{ name: "safe_tool" }] } });
    throw new Error("Cloud API should not be called when token is unavailable");
  };
  const report = await getProjectDiagnostics({
    env: { GOOGLE_CLOUD_PROJECT: "project-1" },
    fetchImpl,
    inspectStorage: inspectHealthyStorage,
    accessTokenProvider: async () => {
      const error = new Error("no identity");
      error.code = "GOOGLE_CLOUD_TOKEN_UNAVAILABLE";
      throw error;
    },
  });
  assert.equal(report.status, "partial");
  assert.equal(report.checks.cloudRun.status, "unavailable");
  assert.equal(
    report.checks.cloudBuildTrigger.errorCode,
    "GOOGLE_CLOUD_TOKEN_UNAVAILABLE",
  );
  assert.equal(report.safety.arbitraryCommands, false);
});

test("diagnostics reports disabled APIs, missing access, and blocked secret references safely", async () => {
  const fetchedSecrets = [];
  const report = await getProjectDiagnostics({
    env: { GOOGLE_CLOUD_PROJECT: "project-1" },
    accessTokenProvider: async () => "test-token",
    inspectStorage: async () => ({
      checks: { firestore: { status: "unavailable" } },
    }),
    fetchImpl: async (url) => {
      if (url.endsWith("/mcp"))
        return response({ result: { tools: [{ name: "safe_tool" }] } });
      if (url.startsWith("https://cloudaicore.com/"))
        return response({ status: "ok" });
      if (url.startsWith("https://monitoring.googleapis.com/")) {
        return response(
          { error: { details: [{ reason: "SERVICE_DISABLED" }] } },
          403,
        );
      }
      if (url.startsWith("https://logging.googleapis.com/")) {
        return response({ error: { message: "unreported-iam-error" } }, 403);
      }
      if (url.startsWith("https://run.googleapis.com/")) {
        return response({
          template: {
            containers: [
              {
                env: [
                  {
                    valueSource: {
                      secretKeyRef: {
                        secret: "projects/other-project/secrets/external",
                        version: "latest",
                      },
                    },
                  },
                  {
                    valueSource: {
                      secretKeyRef: { secret: "local", version: "1" },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.startsWith("https://secretmanager.googleapis.com/")) {
        fetchedSecrets.push(url);
        return response({ state: "DISABLED" });
      }
      return response({});
    },
  });

  assert.equal(report.status, "partial");
  assert.equal(report.checks.firestore.status, "fail");
  assert.equal(report.checks.monitoring.errorCode, "GOOGLE_CLOUD_API_DISABLED");
  assert.equal(
    report.checks.logging.errorCode,
    "GOOGLE_CLOUD_PERMISSION_DENIED",
  );
  assert.equal(report.checks.secretManager.failedVersions, 1);
  assert.equal(report.checks.secretManager.unverifiedVersions, 1);
  assert.deepEqual(fetchedSecrets, [
    "https://secretmanager.googleapis.com/v1/projects/project-1/secrets/local/versions/1",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /unreported-iam-error/u);
});
