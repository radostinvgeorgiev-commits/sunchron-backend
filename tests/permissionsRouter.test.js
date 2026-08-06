import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createPermissionsRouter } from "../src/routes/permissionsRouter.js";

function testApp(options, owner = { id: "owner-1" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/permissions", createPermissionsRouter(options));
  return app;
}

test("lists only safe ChatGPT OAuth grant metadata for the signed-in owner", async () => {
  let input;
  const app = testApp({
    isOAuthConfigured: () => true,
    listGrants: async (options) => {
      input = options;
      return [
        {
          grantId: "grant-1",
          subject: "owner-1",
          memoryOwnerId: "private-memory-owner",
          role: "owner",
          clientId: "https://chatgpt.com/oauth/synchron/client.json",
          scopes: ["synchron:read", "offline_access"],
          issuedAt: "2026-08-06T10:00:00.000Z",
          lastUsedAt: "2026-08-06T10:05:00.000Z",
          expiresAt: "2026-09-05T10:00:00.000Z",
          accessToken: "secret-access-token",
          refreshToken: "secret-refresh-token",
          revokedAt: null,
        },
      ];
    },
  });

  const response = await request(app)
    .get("/permissions/oauth/chatgpt?subject=attacker")
    .expect(200);

  assert.deepEqual(input, { subject: "owner-1" });
  assert.equal(response.body.configured, true);
  assert.equal(response.body.connected, true);
  assert.deepEqual(response.body.grants, [
    {
      grantId: "grant-1",
      clientId: "https://chatgpt.com/oauth/synchron/client.json",
      scopes: ["synchron:read", "offline_access"],
      issuedAt: "2026-08-06T10:00:00.000Z",
      lastUsedAt: "2026-08-06T10:05:00.000Z",
      expiresAt: "2026-09-05T10:00:00.000Z",
    },
  ]);
  assert.match(response.headers["cache-control"], /no-store/u);
  assert.equal(response.headers.pragma, "no-cache");
  assert.doesNotMatch(JSON.stringify(response.body), /secret|memory-owner/u);
  assert.equal(Object.hasOwn(response.body.grants[0], "subject"), false);
  assert.equal(Object.hasOwn(response.body.grants[0], "role"), false);
});

test("revokes all ChatGPT OAuth grants only for the signed-in owner", async () => {
  let input;
  let auditEvent;
  const app = testApp({
    revokeGrants: async (options) => {
      input = options;
      return { revoked: 2 };
    },
    recordAudit: async (event) => {
      auditEvent = event;
    },
  });
  const response = await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ subject: "attacker", all: true })
    .expect(200);

  assert.deepEqual(input, { subject: "owner-1" });
  assert.deepEqual(response.body, {
    status: "ok",
    revoked: 2,
    grantId: null,
  });
  assert.deepEqual(auditEvent, {
    actor: "owner-1",
    action: "oauth.revoke",
    capability: "oauth.manage",
    decision: "confirmed",
    outcome: "succeeded",
    resource: "chatgpt-mcp",
    details: "all_grants",
    sessionId: "owner-1",
  });
  assert.match(response.headers["cache-control"], /no-store/u);
});

test("revokes one exact ChatGPT OAuth grant without accepting another subject", async () => {
  let input;
  const app = testApp({
    revokeGrants: async (options) => {
      input = options;
      return 1;
    },
    recordAudit: async () => {},
  });

  const response = await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ subject: "attacker", grantId: "grant-2" })
    .expect(200);

  assert.deepEqual(input, { subject: "owner-1", grantId: "grant-2" });
  assert.deepEqual(response.body, {
    status: "ok",
    revoked: 1,
    grantId: "grant-2",
  });
});

test("returns safe OAuth management errors without leaking service details", async () => {
  const listApp = testApp({
    isOAuthConfigured: () => true,
    listGrants: async () => {
      throw new Error("OpenSearch password=private-list-secret");
    },
  });
  const listResponse = await request(listApp)
    .get("/permissions/oauth/chatgpt")
    .expect(503);
  assert.equal(listResponse.body.code, "MCP_OAUTH_GRANTS_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(listResponse.body), /password|secret/u);

  const revokeApp = testApp({
    revokeGrants: async () => {
      throw new Error("OpenSearch password=private-revoke-secret");
    },
    recordAudit: async () => {},
  });
  const revokeResponse = await request(revokeApp)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ grantId: "grant-1" })
    .expect(503);
  assert.equal(
    revokeResponse.body.code,
    "MCP_OAUTH_REVOCATION_UNAVAILABLE",
  );
  assert.doesNotMatch(JSON.stringify(revokeResponse.body), /password|secret/u);
});

test("does not turn a missing or invalid target into revoke-all", async () => {
  let called = false;
  const app = testApp({
    revokeGrants: async () => {
      called = true;
      return 1;
    },
    recordAudit: async () => {},
  });

  const response = await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ grantId: "   " })
    .expect(400);

  assert.equal(
    response.body.code,
    "INVALID_MCP_OAUTH_REVOCATION_TARGET",
  );
  assert.equal(called, false);

  await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({})
    .expect(400);
  assert.equal(called, false);

  await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ grantId: "x".repeat(257) })
    .expect(400);
  assert.equal(called, false);

  await request(app)
    .post("/permissions/oauth/chatgpt/revoke")
    .send({ all: true, grantId: "grant-1" })
    .expect(400);
  assert.equal(called, false);
});
