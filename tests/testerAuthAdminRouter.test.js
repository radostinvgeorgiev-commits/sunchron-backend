import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createTesterAuthAdminRouter } from "../src/routes/testerAuthAdminRouter.js";

function appFor(env) {
  const app = express();
  app.use("/admin/tester-auth", createTesterAuthAdminRouter({ env }));
  return app;
}

test("tester auth status points to Google Identity Platform", async () => {
  const response = await request(
    appFor({
      AUTH_BACKEND: "identity-platform",
      GOOGLE_CLOUD_PROJECT: "project-1",
      IDENTITY_PLATFORM_API_KEY: "public-api-key",
      USER_SESSION_ENCRYPTION_KEY: "x".repeat(32),
      SYNCHRON_TEST_INVITE_CODE: "invite-1234",
    }),
  ).get("/admin/tester-auth/status").expect(200);
  assert.equal(response.body.provider, "google-identity-platform");
  assert.equal(response.body.managedIn, "google-cloud-console");
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
});

test("invite code is returned only when registration is configured", async () => {
  const enabled = await request(
    appFor({
      AUTH_BACKEND: "identity-platform",
      GOOGLE_CLOUD_PROJECT: "project-1",
      IDENTITY_PLATFORM_API_KEY: "public-api-key",
      USER_SESSION_ENCRYPTION_KEY: "x".repeat(32),
      SYNCHRON_TEST_INVITE_CODE: "invite-1234",
    }),
  ).get("/admin/tester-auth/invite-code").expect(200);
  assert.equal(enabled.body.inviteCode, "invite-1234");

  const disabled = await request(appFor({}))
    .get("/admin/tester-auth/invite-code")
    .expect(404);
  assert.equal(disabled.body.code, "TESTER_INVITE_NOT_CONFIGURED");
});
