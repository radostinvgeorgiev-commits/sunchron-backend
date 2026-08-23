import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../src/services/googleCloudActionService.js";

const env = {
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  CLOUD_RUN_SERVICE: "synchron-backend-google",
  GOOGLE_CLOUD_REGION: "europe-west1",
  CLOUD_BUILD_TRIGGER_ID: "d943b5bc-a267-4273-a48a-3c750f484a42",
  CLOUD_BUILD_TRIGGER_NAME: "synchron-main-deploy",
};

test("Google Cloud IAM change is normalized and prepared without execution", async () => {
  let captured;
  const result = await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "grant_project_role",
      input: {
        principal:
          "serviceAccount:ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
        role: "roles/owner",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => {
        captured = confirmation;
        return { id: "confirmation-1", expiresAt: 12345 };
      },
    },
  );

  assert.equal(result.confirmationId, "confirmation-1");
  assert.equal(captured.action, "infrastructure.write:grant_project_role");
  assert.equal(captured.resource.projectId, env.GOOGLE_CLOUD_PROJECT);
  assert.equal(
    captured.resource.principal,
    "serviceAccount:ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
  );
  assert.equal(captured.resource.role, "roles/owner");
});

test("Cloud Run service identity changes are limited to the configured service and project", async () => {
  const result = await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "update_cloud_run_service_account",
      input: {
        serviceAccount:
          "ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => ({
        id: "confirmation-2",
        expiresAt: 12345,
        action: confirmation.action,
      }),
    },
  );
  assert.equal(result.resource.serviceName, "synchron-backend-google");
  assert.equal(result.resource.region, "europe-west1");
  assert.equal(
    result.params.serviceAccount,
    "ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
  );

  await assert.rejects(
    () =>
      prepareGoogleCloudAction({
        ownerId: "owner-1",
        sessionId: "session-1",
        operation: "update_cloud_run_service_account",
        input: {
          serviceName: "another-production-service",
          serviceAccount:
            "ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
        },
        env,
      }),
    (error) => error.code === "GOOGLE_CLOUD_SERVICE_PROTECTED",
  );
});

test("Google Cloud confirmation checks owner and delegates the exact action", async () => {
  const calls = [];
  let preparedConfirmation;
  await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "grant_project_role",
      input: {
        principal:
          "serviceAccount:ai-core-admin@handy-boulevard-479120-q9.iam.gserviceaccount.com",
        role: "roles/owner",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => {
        preparedConfirmation = confirmation;
        return { id: "confirmation-3", expiresAt: 12345 };
      },
    },
  );
  const result = await confirmGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      confirmationId: "confirmation-3",
    },
    {
      validateConfirmation: async () => preparedConfirmation,
      consumeConfirmation: async (id) => calls.push(["consume", id]),
      executeWrite: async (input) => {
        calls.push(["execute", input.action, input.capability]);
        return input.execute();
      },
      adapters: {
        changeProjectRole: async (input) => {
          calls.push(["adapter", input.grant]);
          return { changed: true, role: input.role };
        },
      },
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    ["consume", "confirmation-3"],
    ["execute", "infrastructure.write", "infrastructure.write:grant_project_role"],
    ["adapter", true],
  ]);
});

test("Cloud Build trigger run is prepared for one exact main commit", async () => {
  let captured;
  const result = await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "run_cloud_build_trigger",
      input: {
        commitSha: "6DBFB750813C47CCA439DB5BC3E9A3DEBBBB5A3A",
        branch: "main",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => {
        captured = confirmation;
        return { id: "confirmation-build-1", expiresAt: 12345 };
      },
    },
  );

  assert.equal(result.confirmationId, "confirmation-build-1");
  assert.equal(captured.action, "infrastructure.write:run_cloud_build_trigger");
  assert.equal(captured.resource.projectId, env.GOOGLE_CLOUD_PROJECT);
  assert.equal(captured.resource.location, "global");
  assert.equal(captured.resource.triggerName, "synchron-main-deploy");
  assert.equal(captured.resource.branch, "main");
  assert.equal(
    captured.resource.commitSha,
    "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
  );
});

test("Cloud Build confirmation rechecks trigger and runs only the exact prepared SHA", async () => {
  const calls = [];
  let preparedConfirmation;
  await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "run_cloud_build_trigger",
      input: {
        commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
        branch: "main",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => {
        preparedConfirmation = confirmation;
        return { id: "confirmation-build-2", expiresAt: 12345 };
      },
    },
  );

  const result = await confirmGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      confirmationId: "confirmation-build-2",
    },
    {
      validateConfirmation: async () => preparedConfirmation,
      consumeConfirmation: async (id) => calls.push(["consume", id]),
      executeWrite: async (input) => {
        calls.push(["execute", input.action, input.capability]);
        return input.execute();
      },
      adapters: {
        getCloudBuildTrigger: async (input) => {
          calls.push(["get-trigger", input.triggerId, input.triggerName]);
          return { displayName: input.triggerName, disabled: false, github: { push: { branch: "^main$" } } };
        },
        runCloudBuildTrigger: async (input) => {
          calls.push(["run", input.commitSha, input.branch]);
          return { operationName: "operations/build-1", commitSha: input.commitSha };
        },
      },
    },
  );

  assert.deepEqual(result, {
    operationName: "operations/build-1",
    commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
  });
  assert.deepEqual(calls, [
    ["get-trigger", env.CLOUD_BUILD_TRIGGER_ID, "synchron-main-deploy"],
    ["consume", "confirmation-build-2"],
    [
      "execute",
      "infrastructure.write",
      "infrastructure.write:run_cloud_build_trigger",
    ],
    ["run", "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a", "main"],
  ]);
});

test("Cloud Build uses the regional trigger endpoint and direct RepoSource body", async () => {
  let preparedConfirmation;
  const requests = [];
  await prepareGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      operation: "run_cloud_build_trigger",
      input: {
        commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
        branch: "main",
      },
      env,
    },
    {
      createConfirmation: async (confirmation) => {
        preparedConfirmation = confirmation;
        return { id: "confirmation-build-api", expiresAt: 12345 };
      },
    },
  );

  const result = await confirmGoogleCloudAction(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      confirmationId: "confirmation-build-api",
    },
    {
      validateConfirmation: async () => preparedConfirmation,
      consumeConfirmation: async () => {},
      executeWrite: async (input) => input.execute(),
      adapters: {
        fetchImpl: async (url, options = {}) => {
          requests.push({ url, options });
          if (url.startsWith("http://metadata.google.internal/")) {
            return { ok: true, json: async () => ({ access_token: "token" }) };
          }
          if (options.method === "POST") {
            return {
              ok: true,
              text: async () => JSON.stringify({ name: "operations/build-2" }),
            };
          }
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                resourceName:
                  "projects/handy-boulevard-479120-q9/locations/global/triggers/d943b5bc-a267-4273-a48a-3c750f484a42",
                name: "synchron-main-deploy",
                disabled: false,
                triggerTemplate: { branchName: "^main$" },
              }),
          };
        },
      },
    },
  );

  assert.equal(result.operationName, "operations/build-2");
  assert.equal(
    requests[1].url,
    "https://cloudbuild.googleapis.com/v1/projects/handy-boulevard-479120-q9/locations/global/triggers/d943b5bc-a267-4273-a48a-3c750f484a42",
  );
  assert.equal(
    requests[3].url,
    "https://cloudbuild.googleapis.com/v1/projects/handy-boulevard-479120-q9/locations/global/triggers/d943b5bc-a267-4273-a48a-3c750f484a42:run",
  );
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
  });
});

test("Cloud Build trigger run rejects non-main and non-exact revisions", async () => {
  await assert.rejects(
    () =>
      prepareGoogleCloudAction({
        ownerId: "owner-1",
        sessionId: "session-1",
        operation: "run_cloud_build_trigger",
        input: {
          commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
          branch: "develop",
        },
        env,
      }),
    (error) => error.code === "GOOGLE_CLOUD_TRIGGER_BRANCH_PROTECTED",
  );
  await assert.rejects(
    () =>
      prepareGoogleCloudAction({
        ownerId: "owner-1",
        sessionId: "session-1",
        operation: "run_cloud_build_trigger",
        input: { commitSha: "main", branch: "main" },
        env,
      }),
    (error) => error.code === "GOOGLE_CLOUD_COMMIT_SHA_INVALID",
  );
});
