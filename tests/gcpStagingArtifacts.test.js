import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  renderCloudRunService,
  validateStagingConfiguration,
} from "../scripts/renderCloudRunStaging.js";
import {
  verifyAuthSessionPayload,
  verifyCloudRunDescription,
  verifyHealthPayload,
  verifyPrivateIamPolicy,
  verifyReadinessPayload,
} from "../scripts/verifyCloudRunStaging.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function stagingConfiguration() {
  return {
    projectId: "handy-boulevard-479120-q9",
    projectNumber: "975434100844",
    region: "europe-west1",
    serviceName: "synchron-backend-staging",
    serviceAccount:
      "synchron-runner@handy-boulevard-479120-q9.iam.gserviceaccount.com",
    imageUri: `europe-west1-docker.pkg.dev/handy-boulevard-479120-q9/synchron/backend@sha256:${DIGEST}`,
    commitSha: SHA,
    memoryOwnerId: "synchron-gcp-staging-owner",
    mcpResourceUrl: "https://synchron-backend-staging-example-ew.a.run.app/mcp",
    secrets: Object.fromEntries(
      [
        "OPENAI_API_KEY",
        "IDENTITY_PLATFORM_API_KEY",
        "USER_SESSION_ENCRYPTION_KEY",
        "GITHUB_SESSION_ENCRYPTION_KEY",
        "GOOGLE_SESSION_ENCRYPTION_KEY",
        "SYNCHRON_TEST_INVITE_CODE",
        "MCP_ACCESS_TOKEN",
        "MCP_OAUTH_SECRET",
      ].map((name, index) => [
        name,
        {
          name: `synchron-${name.toLowerCase().replaceAll("_", "-")}`,
          version: String(index + 1),
        },
      ]),
    ),
  };
}

function cloudRunDescription() {
  const aliases = {
    OPENAI_API_KEY: "openai-api-key",
    IDENTITY_PLATFORM_API_KEY: "identity-platform-api-key",
    USER_SESSION_ENCRYPTION_KEY: "user-session-key",
    GITHUB_SESSION_ENCRYPTION_KEY: "github-session-key",
    GOOGLE_SESSION_ENCRYPTION_KEY: "google-session-key",
    SYNCHRON_TEST_INVITE_CODE: "tester-invite-code",
    MCP_ACCESS_TOKEN: "mcp-access-token",
    MCP_OAUTH_SECRET: "mcp-oauth-secret",
  };
  const secretEnv = [
    "OPENAI_API_KEY",
    "IDENTITY_PLATFORM_API_KEY",
    "USER_SESSION_ENCRYPTION_KEY",
    "GITHUB_SESSION_ENCRYPTION_KEY",
    "GOOGLE_SESSION_ENCRYPTION_KEY",
    "SYNCHRON_TEST_INVITE_CODE",
    "MCP_ACCESS_TOKEN",
    "MCP_OAUTH_SECRET",
  ].map((name) => ({
    name,
    valueFrom: { secretKeyRef: { name: aliases[name], key: "1" } },
  }));
  return {
    metadata: {
      name: "synchron-backend-staging",
      annotations: { "run.googleapis.com/ingress": "all" },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/minScale": "0",
            "autoscaling.knative.dev/maxScale": "2",
          },
        },
        spec: {
          serviceAccountName:
            "synchron-runner@handy-boulevard-479120-q9.iam.gserviceaccount.com",
          containers: [
            {
              image: `europe-west1-docker.pkg.dev/handy-boulevard-479120-q9/synchron/backend@sha256:${DIGEST}`,
              env: [
                { name: "APP_COMMIT_SHA", value: SHA },
                { name: "MEMORY_BACKEND", value: "firestore" },
                { name: "PERSISTENCE_BACKEND", value: "firestore" },
                { name: "AUTH_BACKEND", value: "identity-platform" },
                ...secretEnv,
              ],
            },
          ],
        },
      },
    },
    status: {
      latestReadyRevisionName: "synchron-backend-staging-00001-safe",
      url: "https://synchron-backend-staging-example-ew.a.run.app",
    },
  };
}

test("Cloud Run staging renderer pins image, secrets, scaling and service identity", async () => {
  const template = await readFile(
    new URL("../deploy/cloud-run/service.yaml.template", import.meta.url),
    "utf8",
  );
  const rendered = renderCloudRunService(template, stagingConfiguration());

  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/u);
  assert.match(rendered, new RegExp(`image: ".*@sha256:${DIGEST}"`, "u"));
  assert.match(rendered, /run\.googleapis\.com\/secrets:/u);
  assert.match(
    rendered,
    /openai-api-key:projects\/975434100844\/secrets\/synchron-openai-api-key/u,
  );
  assert.match(rendered, /autoscaling\.knative\.dev\/minScale: "0"/u);
  assert.match(rendered, /autoscaling\.knative\.dev\/maxScale: "2"/u);
  assert.match(rendered, /run\.googleapis\.com\/ingress: all/u);
  assert.match(rendered, /name: MEMORY_BACKEND\s+value: firestore/u);
  assert.match(rendered, /name: AUTH_BACKEND\s+value: identity-platform/u);
  assert.match(rendered, /name: SYNCHRON_TEST_INVITE_CODE/u);
  assert.doesNotMatch(rendered, /name: TESTER_INVITE_CODE/u);
  assert.doesNotMatch(rendered, /\bkey:\s*["']?latest\b/iu);
});

test("staging renderer rejects mutable images and non-numeric secret versions", () => {
  const mutable = stagingConfiguration();
  mutable.imageUri =
    "europe-west1-docker.pkg.dev/handy-boulevard-479120-q9/synchron/backend:latest";
  assert.throws(
    () => validateStagingConfiguration(mutable),
    (error) => error.code === "GCP_STAGING_CONFIGURATION_INVALID",
  );

  const floatingSecret = stagingConfiguration();
  floatingSecret.secrets.OPENAI_API_KEY.version = "latest";
  assert.throws(
    () => validateStagingConfiguration(floatingSecret),
    (error) => error.code === "GCP_STAGING_CONFIGURATION_INVALID",
  );
});

test("read-only staging verifier requires private IAM and exact GCP readiness", () => {
  const verified = verifyCloudRunDescription(cloudRunDescription(), {
    serviceName: "synchron-backend-staging",
    expectedSha: SHA,
    projectId: "handy-boulevard-479120-q9",
    region: "europe-west1",
  });
  assert.equal(verified.revision, "synchron-backend-staging-00001-safe");
  assert.equal(
    verifyPrivateIamPolicy({
      bindings: [
        {
          role: "roles/run.invoker",
          members: ["user:owner@example.invalid"],
        },
      ],
    }),
    true,
  );
  assert.equal(verifyHealthPayload({ status: "ok", commit: SHA }, SHA), true);
  assert.equal(
    verifyReadinessPayload(
      {
        status: "ready",
        commit: SHA,
        checks: {
          chatAgent: { ready: true },
          memory: { ready: true, backend: "firestore" },
          memoryAcceptance: {
            ready: true,
            passedSteps: 9,
            isolated: true,
            realMemoryUnchanged: true,
            cleanupCompleted: true,
          },
        },
      },
      SHA,
    ),
    true,
  );
  assert.equal(
    verifyAuthSessionPayload({
      configured: true,
      configuration: {
        projectConnection: true,
        sessionProtection: true,
      },
      registrationEnabled: true,
      authProvider: "identity-platform",
      authenticated: false,
    }),
    true,
  );
});

test("staging verifier blocks public invokers and floating secret references", () => {
  assert.throws(
    () =>
      verifyPrivateIamPolicy({
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
      }),
    (error) => error.code === "GCP_STAGING_VERIFICATION_FAILED",
  );

  const description = cloudRunDescription();
  description.spec.template.spec.containers[0].env.find(
    (entry) => entry.name === "OPENAI_API_KEY",
  ).valueFrom.secretKeyRef.key = "latest";
  assert.throws(
    () =>
      verifyCloudRunDescription(description, {
        serviceName: "synchron-backend-staging",
        expectedSha: SHA,
        projectId: "handy-boulevard-479120-q9",
        region: "europe-west1",
      }),
    (error) => error.code === "GCP_STAGING_VERIFICATION_FAILED",
  );
});
