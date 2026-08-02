import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createDigitalOceanDomainAdminRouter,
  DIGITALOCEAN_DOMAIN_ACTION,
} from "../src/routes/digitalOceanDomainAdminRouter.js";
import { DigitalOceanError } from "../src/services/digitalOceanService.js";

function testApp(options) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { id: "owner" };
    next();
  });
  app.use(
    "/api/digitalocean-domain",
    createDigitalOceanDomainAdminRouter(options),
  );
  return app;
}

test("reports the current www domain state without writing", async () => {
  const app = testApp({
    inspect: async () => ({
      appId: "app-1",
      domain: "www.synchron.foundation",
      configured: false,
      readAccessVerified: true,
      requiredWriteScope: "app:update",
    }),
  });

  const response = await request(app)
    .get("/api/digitalocean-domain/status")
    .expect(200);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.domain, "www.synchron.foundation");
  assert.match(response.headers["cache-control"], /no-store/u);
});

test("shows a safe actionable message when DigitalOcean is unreachable", async () => {
  const app = testApp({
    inspect: async () => {
      throw new DigitalOceanError(
        "DigitalOcean API временно не е достъпен. Опитай отново след малко.",
        502,
        "DIGITALOCEAN_NETWORK_ERROR",
      );
    },
  });

  const response = await request(app)
    .get("/api/digitalocean-domain/status")
    .expect(502);
  assert.equal(response.body.code, "DIGITALOCEAN_NETWORK_ERROR");
  assert.match(response.body.error, /Опитай отново/u);
});

test("shows a safe actionable message for an invalid DigitalOcean app spec", async () => {
  const app = testApp({
    inspect: async () => {
      throw new DigitalOceanError(
        "DigitalOcean не върна валиден app spec.",
        502,
        "DIGITALOCEAN_INVALID_APP_SPEC",
      );
    },
  });

  const response = await request(app)
    .post("/api/digitalocean-domain/prepare")
    .send({})
    .expect(502);
  assert.equal(response.body.code, "DIGITALOCEAN_INVALID_APP_SPEC");
  assert.equal(
    response.body.error,
    "DigitalOcean не върна валиден app spec.",
  );
});

test("prepares an exact owner confirmation for only the www domain", async () => {
  let created;
  const app = testApp({
    inspect: async () => ({
      appId: "app-1",
      domain: "www.synchron.foundation",
      configured: false,
      readAccessVerified: true,
      requiredWriteScope: "app:update",
    }),
    createConfirmation: async (input) => {
      created = input;
      return { id: "confirmation-www", expiresAt: Date.now() + 60_000 };
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/digitalocean-domain/prepare")
    .send({})
    .expect(201);
  assert.equal(response.body.confirmationId, "confirmation-www");
  assert.equal(created.sessionId, "owner");
  assert.equal(created.action, DIGITALOCEAN_DOMAIN_ACTION);
  assert.deepEqual(created.resource, {
    appId: "app-1",
    domain: "www.synchron.foundation",
  });
  assert.match(response.body.message, /без изтриване/u);
});

test("consumes the confirmation before the audited DigitalOcean write", async () => {
  const events = [];
  const app = testApp({
    validateConfirmation: async (id, ownerId) => {
      assert.equal(id, "confirmation-www");
      assert.equal(ownerId, "owner");
      return {
        action: DIGITALOCEAN_DOMAIN_ACTION,
        resource: {
          appId: "app-1",
          domain: "www.synchron.foundation",
        },
      };
    },
    consumeConfirmation: async (id) => events.push(`consume:${id}`),
    executeWrite: async ({ execute, resource }) => {
      events.push(`audit:${resource}`);
      return execute();
    },
    activate: async (input) => {
      events.push("activate");
      assert.equal(input.expectedAppId, "app-1");
      assert.equal(input.domain, "www.synchron.foundation");
      return {
        updated: true,
        domain: input.domain,
        deploymentId: "deploy-www",
      };
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/digitalocean-domain/confirm")
    .send({ confirmationId: "confirmation-www" })
    .expect(200);
  assert.deepEqual(events, [
    "consume:confirmation-www",
    "audit:www.synchron.foundation",
    "activate",
  ]);
  assert.equal(response.body.deploymentId, "deploy-www");
});

test("blocks a confirmation for another domain", async () => {
  let activated = false;
  const app = testApp({
    validateConfirmation: async () => ({
      action: DIGITALOCEAN_DOMAIN_ACTION,
      resource: { appId: "app-1", domain: "other.example.com" },
    }),
    activate: async () => {
      activated = true;
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/api/digitalocean-domain/confirm")
    .send({ confirmationId: "confirmation-other" })
    .expect(409);
  assert.equal(response.body.code, "CONFIRMATION_DOMAIN_MISMATCH");
  assert.equal(activated, false);
});
