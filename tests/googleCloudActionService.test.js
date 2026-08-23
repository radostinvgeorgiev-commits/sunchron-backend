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
