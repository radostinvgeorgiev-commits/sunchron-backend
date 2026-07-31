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
    inspectDigitalOcean: async () => ({
      appId: "app-1",
      missingKeys: [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SESSION_ENCRYPTION_KEY",
        "SYNCHRON_TEST_INVITE_CODE",
      ],
      readAccessVerified: true,
      requiredWriteScope: "app:update",
      writeAccess: "verified-on-update",
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
  assert.equal(created.resource.appId, "app-1");
  assert.equal(created.params.publishableKey, BOOTSTRAP.publishableKey);
  assert.equal(response.body.readAccessVerified, true);
  assert.equal(response.body.requiredWriteScope, "app:update");
  assert.equal(response.body.writeAccess, "verified-on-update");
  assert.match(response.body.message, /Предварителната проверка/u);
});

test("returns the exact safe DigitalOcean permission error", async () => {
  const error = new Error(
    "DigitalOcean токенът няма право да променя App Platform. Нужно е разрешение app:update заедно с app:read.",
  );
  error.name = "DigitalOceanError";
  error.status = 403;
  error.code = "DIGITALOCEAN_APP_UPDATE_FORBIDDEN";
  const app = testApp({
    validateConfirmation: async () => ({
      action: ACTION,
      resource: { appId: "app-1" },
      params: BOOTSTRAP,
    }),
    consumeConfirmation: async () => {},
    activate: async () => {
      throw error;
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/tester-auth/confirm")
    .send({ confirmationId: "confirmation-1" })
    .expect(403);

  assert.equal(response.body.code, "DIGITALOCEAN_APP_UPDATE_FORBIDDEN");
  assert.match(response.body.error, /app:update/u);
  assert.doesNotMatch(response.body.error, /не успя$/u);
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

test("successful activation with failed final audit is reported as uncertain", async () => {
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
    executeWrite: async ({ execute }) => {
      await execute();
      const error = new Error(
        "Действието може да е извършено, но крайният журнал не можа да бъде записан. Не го повтаряй автоматично.",
      );
      error.code = "AUDIT_OUTCOME_UNCERTAIN";
      error.status = 502;
      throw error;
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/tester-auth/confirm")
    .send({ confirmationId: "confirmation-1" })
    .expect(502);

  assert.equal(response.body.code, "AUDIT_OUTCOME_UNCERTAIN");
  assert.match(response.body.error, /Не го повтаряй автоматично/u);
});

test("missing audit intent blocks DigitalOcean before activation", async () => {
  let activated = false;
  const app = testApp({
    validateConfirmation: async () => ({
      action: ACTION,
      resource: { appId: "app-1" },
      params: BOOTSTRAP,
    }),
    consumeConfirmation: async () => {},
    executeWrite: async () => {
      const error = new Error(
        "Журналът не е достъпен. Действието не беше стартирано.",
      );
      error.code = "AUDIT_UNAVAILABLE";
      error.status = 503;
      throw error;
    },
    activate: async () => {
      activated = true;
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/tester-auth/confirm")
    .send({ confirmationId: "confirmation-1" })
    .expect(503);

  assert.equal(response.body.code, "AUDIT_UNAVAILABLE");
  assert.equal(activated, false);
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

test("uses a stable derived invite when dedicated tester secrets are absent", async () => {
  const env = {
    SUPABASE_URL: BOOTSTRAP.projectUrl,
    SUPABASE_PUBLISHABLE_KEY: BOOTSTRAP.publishableKey,
    GITHUB_SESSION_ENCRYPTION_KEY:
      "owner-session-encryption-key-with-enough-entropy",
  };
  const app = testApp({ env });

  const status = await request(app).get("/api/tester-auth/status").expect(200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.registrationEnabled, true);

  const first = await request(app)
    .get("/api/tester-auth/invite-code")
    .expect(200);
  const second = await request(app)
    .get("/api/tester-auth/invite-code")
    .expect(200);
  assert.equal(first.body.inviteCode, second.body.inviteCode);
  assert.equal(first.body.inviteCode.length, 16);
  assert.doesNotMatch(first.body.inviteCode, /owner-session-encryption-key/u);
});
