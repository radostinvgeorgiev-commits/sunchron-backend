import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createApiRateLimiter } from "../src/middleware/rateLimits.js";

process.env.NODE_ENV = "test";

test("rate limiter returns a stable JSON error after the configured limit", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    createApiRateLimiter({
      limit: 2,
      windowMs: 60_000,
      code: "TEST_RATE_LIMIT",
    }),
  );
  app.get("/", (_req, res) => res.json({ ok: true }));

  await request(app).get("/").expect(200);
  await request(app).get("/").expect(200);
  const blocked = await request(app).get("/").expect(429);

  assert.equal(blocked.body.code, "TEST_RATE_LIMIT");
});

test("server does not grant cross-origin browser access", async () => {
  const { default: app } = await import("../server.js");
  const response = await request(app)
    .get("/health")
    .set("Origin", "https://attacker.example")
    .expect(200);

  assert.equal(response.headers["access-control-allow-origin"], undefined);
});
