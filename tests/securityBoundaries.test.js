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

test("page loads read the sign-in apart from sign-in attempts", async () => {
  const { limitReadsApart } = await import("../src/middleware/rateLimits.js");
  const app = express();
  app.set("trust proxy", 1);
  const readLimiter = createApiRateLimiter({ limit: 5, windowMs: 60_000, code: "TEST_READ_LIMIT" });
  const otherLimiter = createApiRateLimiter({ limit: 2, windowMs: 60_000, code: "TEST_ATTEMPT_LIMIT" });
  const router = express.Router();
  router.get("/session", (_req, res) => res.json({ read: true }));
  router.get("/google/start", (_req, res) => res.json({ attempt: true }));
  router.post("/session", (_req, res) => res.json({ post: true }));
  app.use("/api/auth", limitReadsApart({ readPaths: ["/session"], readLimiter, otherLimiter }), router);

  // Many more page loads than sign-in attempts are allowed.
  for (const path of ["/api/auth/session", "/api/auth/session/", "/api/auth/Session", "/api/auth/session?x=1"]) {
    await request(app).get(path).expect(200);
  }
  await request(app).get("/api/auth/google/start").expect(200);
  await request(app).get("/api/auth/google/start").expect(200);
  const attempts = await request(app).get("/api/auth/google/start").expect(429);
  assert.equal(attempts.body.code, "TEST_ATTEMPT_LIMIT");
  // Reading still works after the attempts ran out, until its own limit.
  await request(app).get("/api/auth/session").expect(200);
  const reads = await request(app).get("/api/auth/session").expect(429);
  assert.equal(reads.body.code, "TEST_READ_LIMIT");
  // Only GET reads: a POST to the same path is counted as an attempt.
  const posted = await request(app).post("/api/auth/session").expect(429);
  assert.equal(posted.body.code, "TEST_ATTEMPT_LIMIT");
});

test("the site counts session and GitHub status reads apart from sign-in attempts", async () => {
  const { default: app } = await import("../server.js");
  // draft-8 headers name every limit a request passed: a read passes only
  // the read limit, an attempt only the 60 attempts.
  const response = await request(app).get("/api/auth/session").expect(200);
  assert.match(String(response.headers["ratelimit-policy"]), /q=600\b/u);
  assert.doesNotMatch(String(response.headers["ratelimit-policy"]), /q=60\b/u);
  const status = await request(app).get("/api/github/status");
  assert.match(String(status.headers["ratelimit-policy"]), /q=600\b/u);
  assert.doesNotMatch(String(status.headers["ratelimit-policy"]), /q=60\b/u);
  const attempt = await request(app).get("/api/auth/google/start");
  assert.notEqual(attempt.status, 429);
  assert.match(String(attempt.headers["ratelimit-policy"]), /q=60\b/u);
  assert.doesNotMatch(String(attempt.headers["ratelimit-policy"]), /q=600\b/u);

  // More page loads than the 60 attempts allowed still leave the sign-in
  // attempts open (28.11: the shared limit answered 429 to page loads).
  for (let read = 0; read < 61; read += 1) {
    await request(app).get(read % 2 ? "/api/github/status" : "/api/auth/session").expect(200);
  }
  const after = await request(app).get("/api/auth/google/start");
  assert.notEqual(after.status, 429);
});

test("a limit from the environment counts only as a whole number above zero", async () => {
  const { positiveInteger, createRateLimiters } = await import("../src/middleware/rateLimits.js");
  assert.equal(positiveInteger("600", 60), 600);
  assert.equal(positiveInteger(" 900 ", 60), 900);
  assert.equal(positiveInteger(5, 60), 5);
  for (const value of [undefined, null, "", "abc", "0", "-5", "10abc", "1e3", "12.5", "99999999999999999999"]) {
    assert.equal(positiveInteger(value, 600), 600, String(value));
  }
  // A typo in one group's limit keeps that group's own limit, not 60.
  const limiters = createRateLimiters({ SESSION_READ_RATE_LIMIT: "abc", PRIVATE_API_RATE_LIMIT: "0" });
  const app = express();
  app.get("/read", limiters.sessionReadRateLimiter, (_req, res) => res.json({ ok: true }));
  app.get("/private", limiters.privateApiRateLimiter, (_req, res) => res.json({ ok: true }));
  assert.match(String((await request(app).get("/read")).headers["ratelimit-policy"]), /q=600\b/u);
  assert.match(String((await request(app).get("/private")).headers["ratelimit-policy"]), /q=300\b/u);
});
