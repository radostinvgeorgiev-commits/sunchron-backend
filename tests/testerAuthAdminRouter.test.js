import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createTesterAuthAdminRouter } from "../src/routes/testerAuthAdminRouter.js";

const ACTION = "infrastructure.digitalocean:activate_tester_auth";
const BOOTSTRAP = {
  projectUrl: "https://projectref.supabase.co",
  publishableKey: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
};

function testApp(options) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { id: "owner" };
    next();
  });
  app.use("/api/tester-auth", createTesterAuthAdminRouter(options));
  return app;
}

test("prepares an exact owner confirmation without returning the publishable key", async () => {
  let created;
  const app = testApp({
    bootstrap: BOOTSTRAP,
    getDigitalOceanStatus: async () => ({
      id: "app-1",
      environmentVariables: [],
    }),
    createConfirmation: async (input) => {
      created = input;
      return { id: "confirmation-1", expiresAt: Date.now() + 60_000 };
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/tester-auth/prepare")
    .send({})
    .expect(201);

  assert.equal(response.body.confirmationId, "confirmation-1");
  assert.equal(response.body.missingKeys.length, 4);
  assert.equal(
    JSON.stringify(response.body).includes("sb_publishable_"),
    false,
  );
  assert.equal(created.action, ACTION);
  assert.equal(created.sessionId, "owner");
  assert.equal(created.params.publishableKey, BOOTSTRAP.publishableKey);
});

test("consumes the exact confirmation before activating DigitalOcean", async () => {
  const events = [];
  const app = testApp({
    validateConfirmation: async (id, ownerId) => {
      assert.equal(id, "confirmation-1");
      assert.equal(ownerId, "owner");
      return {
        action: ACTION,
        resource: { appId: "app-1" },
        params: BOOTSTRAP,
      };
    },
    consumeConfirmation: async (id) => events.push(`consume:${id}`),
    activate: async (input) => {
      events.push("activate");
      assert.equal(input.expectedAppId, "app-1");
      return {
        updated: true,
        appId: "app-1",
        changedKeys: ["SUPABASE_URL"],
        deploymentId: "deploy-1",
        inviteCode: "private-invite",
      };
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/tester-auth/confirm")
    .send({ confirmationId: "confirmation-1" })
    .expect(200);

  assert.deepEqual(events, ["consume:confirmation-1", "activate"]);
  assert.equal(response.body.deploymentId, "deploy-1");
  assert.equal(response.body.inviteCode, "private-invite");
});

test("audit storage failure cannot turn a successful activation into a failure", async () => {
  const app = testApp({
    validateConfirmation: async () => ({
      action: ACTION,
      resource: { appId: "app-1" },
      params: BOOTSTRAP,
    }),
    consumeConfirmation: async () => {},
    activate: async () => ({
      updated: true,
      appId: "app-1",
      changedKeys: ["SUPABASE_URL"],
      deploymentId: "deploy-1",
      inviteCode: "private-invite",
    }),
    audit: async () => {
      throw new Error("audit unavailable");
    },
  });

  const response = await request(app)
    .post("/api/tester-auth/confirm")
    .send({ confirmationId: "confirmation-1" })
    .expect(200);

  assert.equal(response.body.status, "ok");
  assert.equal(response.body.deploymentId, "deploy-1");
});

test("reveals the invite code only from the owner-protected admin router", async () => {
  const app = testApp({
    env: {
      SUPABASE_URL: BOOTSTRAP.projectUrl,
      SUPABASE_PUBLISHABLE_KEY: BOOTSTRAP.publishableKey,
      SUPABASE_SESSION_ENCRYPTION_KEY:
        "session-encryption-key-with-enough-entropy",
      SYNCHRON_TEST_INVITE_CODE: "private-invite",
    },
  });

  const status = await request(app).get("/api/tester-auth/status").expect(200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.registrationEnabled, true);

  const invite = await request(app)
    .get("/api/tester-auth/invite-code")
    .expect(200);
  assert.equal(invite.body.inviteCode, "private-invite");
  assert.match(invite.headers["cache-control"], /no-store/u);
});
