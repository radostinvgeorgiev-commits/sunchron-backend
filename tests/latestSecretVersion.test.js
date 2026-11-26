import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
  useLatestSecretVersion,
} from "../src/services/googleCloudActionService.js";

const env = { GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9", K_SERVICE: "synchron-backend-google" };

test("only AI provider keys can be moved to the latest secret version", async () => {
  const created = [];
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "owner", operation: "use_latest_secret_version", input: { envName: "ANTHROPIC_API_KEY" }, env },
    { createConfirmation: async (item) => (created.push(item), { id: "c1", expiresAt: 1 }) },
  );
  assert.equal(prepared.params.envName, "ANTHROPIC_API_KEY");
  assert.equal(created[0].action, "infrastructure.write:use_latest_secret_version");
  for (const envName of ["USER_SESSION_ENCRYPTION_KEY", "MCP_OAUTH_SECRET", ""]) {
    await assert.rejects(
      prepareGoogleCloudAction(
        { ownerId: "owner", sessionId: "owner", operation: "use_latest_secret_version", input: { envName }, env },
        { createConfirmation: async () => ({ id: "x" }) },
      ),
    );
  }
});

test("the Cloud Run template is patched to latest without touching values", async () => {
  const calls = [];
  const service = {
    etag: "e1",
    template: {
      containers: [
        {
          env: [
            { name: "ANTHROPIC_API_KEY", valueSource: { secretKeyRef: { secret: "projects/1/secrets/anthropic-api-key", version: "3" } } },
            { name: "OPENAI_API_KEY", valueSource: { secretKeyRef: { secret: "openai-api-key", version: "7" } } },
            { name: "AI_CORE_PROVIDER", value: "openai" },
          ],
        },
      ],
    },
  };
  const fetchImpl = async (url, options) => {
    if (url.includes("metadata.google.internal")) return Response.json({ access_token: "t" });
    calls.push({ method: options.method || "GET", url, body: options.body && JSON.parse(options.body) });
    return Response.json(options.method === "PATCH" ? {} : structuredClone(service));
  };
  const result = await useLatestSecretVersion({
    projectId: "handy-boulevard-479120-q9",
    serviceName: "synchron-backend-google",
    region: "europe-west1",
    envName: "ANTHROPIC_API_KEY",
    fetchImpl,
  });
  assert.deepEqual(result, { envName: "ANTHROPIC_API_KEY", secret: "anthropic-api-key", previousVersion: "3", version: "latest" });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.match(patch.url, /\/v2\/projects\/handy-boulevard-479120-q9\/locations\/europe-west1\/services\/synchron-backend-google$/u);
  const env = patch.body.template.containers[0].env;
  assert.equal(env[0].valueSource.secretKeyRef.version, "latest");
  assert.equal(env[1].valueSource.secretKeyRef.version, "7");
  assert.equal(patch.body.etag, "e1");

  await assert.rejects(
    useLatestSecretVersion({ projectId: "p", serviceName: "s", region: "r", envName: "GROK_API_KEY", fetchImpl }),
    { code: "GOOGLE_CLOUD_SECRET_ENV_NOT_FOUND" },
  );
});

test("confirming runs the secret switch only for the owner who prepared it", async () => {
  const confirmation = {
    action: "infrastructure.write:use_latest_secret_version",
    resource: { projectId: "p", serviceName: "s", region: "r", ownerFingerprint: null },
    params: { envName: "ANTHROPIC_API_KEY" },
  };
  const { prepareGoogleCloudAction: _ignored, ...rest } = await import("../src/services/googleCloudActionService.js");
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "owner", operation: "use_latest_secret_version", input: { envName: "ANTHROPIC_API_KEY" }, env },
    { createConfirmation: async (item) => (Object.assign(confirmation, item), { id: "c1", expiresAt: 1 }) },
  );
  assert.ok(prepared && rest);
  const ran = [];
  const result = await confirmGoogleCloudAction(
    { ownerId: "owner", sessionId: "owner", confirmationId: "c1" },
    {
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => {},
      executeWrite: async ({ execute }) => execute(),
      adapters: { useLatestSecretVersion: async (input) => (ran.push(input), { ok: true }) },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(ran[0].envName, "ANTHROPIC_API_KEY");
  await assert.rejects(
    confirmGoogleCloudAction(
      { ownerId: "someone-else", sessionId: "owner", confirmationId: "c1" },
      { validateConfirmation: async () => confirmation, consumeConfirmation: async () => {}, executeWrite: async ({ execute }) => execute() },
    ),
    { code: "GOOGLE_CLOUD_OWNER_MISMATCH" },
  );
});
