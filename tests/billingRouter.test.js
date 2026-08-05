import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import billingRouter from "../src/routes/billingRouter.js";

const TEST_ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  BILLING_FREE_TOKENS: "500",
};

const OWNER = {
  id: "user-uuid-test",
  email: "test@example.com",
  displayName: "Test User",
  role: "member",
  memoryOwnerId: "supabase:user-uuid-test",
};

function createApp(owner = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/billing", billingRouter);
  return app;
}

function createUnauthApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/billing", billingRouter);
  return app;
}

function makeBalance(tokens) {
  return JSON.stringify([{ tokens, last_updated: "2026-01-01T00:00:00Z" }]);
}

// ─── unauthenticated tests (no env needed) ────────────────────────────────

test("GET /api/billing/balance — 401 when not authenticated", async () => {
  const res = await request(createUnauthApp())
    .get("/api/billing/balance")
    .expect(401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("GET /api/billing/transactions — 401 when not authenticated", async () => {
  const res = await request(createUnauthApp())
    .get("/api/billing/transactions")
    .expect(401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("POST /api/billing/purchase-tokens — 401 when not authenticated", async () => {
  const res = await request(createUnauthApp())
    .post("/api/billing/purchase-tokens")
    .send({ amount: 100 })
    .expect(401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

// ─── configured: false (no SUPABASE_URL in env) ───────────────────────────

test("GET /api/billing/balance — configured:false when no env", async () => {
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const res = await request(createApp())
      .get("/api/billing/balance")
      .expect(200);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.userId, OWNER.id);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_URL = saved;
  }
});

test("GET /api/billing/transactions — configured:false when no env", async () => {
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const res = await request(createApp())
      .get("/api/billing/transactions")
      .expect(200);
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.transactions, []);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_URL = saved;
  }
});

test("POST /api/billing/purchase-tokens — 503 when billing not configured", async () => {
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const res = await request(createApp())
      .post("/api/billing/purchase-tokens")
      .send({ amount: 100 })
      .expect(503);
    assert.equal(res.body.code, "BILLING_NOT_CONFIGURED");
  } finally {
    if (saved !== undefined) process.env.SUPABASE_URL = saved;
  }
});

// ─── configured: true (with env + mock fetch) ────────────────────────────

test("GET /api/billing/balance — returns balance", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedPub = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = TEST_ENV.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_ENV.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = TEST_ENV.SUPABASE_PUBLISHABLE_KEY;
  global.fetch = async () => new Response(makeBalance(9500), { status: 200 });
  try {
    const res = await request(createApp())
      .get("/api/billing/balance")
      .expect(200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.tokens, 9500);
  } finally {
    delete global.fetch;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (savedPub !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = savedPub;
    else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  }
});

test("GET /api/billing/transactions — returns list", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedPub = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = TEST_ENV.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_ENV.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = TEST_ENV.SUPABASE_PUBLISHABLE_KEY;
  const txList = [
    { id: "t1", amount: 500, type: "purchase", description: "Стартови токени", created_at: "2026-01-01T00:00:00Z" },
  ];
  global.fetch = async () => new Response(JSON.stringify(txList), { status: 200 });
  try {
    const res = await request(createApp())
      .get("/api/billing/transactions")
      .expect(200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.transactions.length, 1);
  } finally {
    delete global.fetch;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (savedPub !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = savedPub;
    else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  }
});

test("POST /api/billing/purchase-tokens — adds tokens", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedPub = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = TEST_ENV.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_ENV.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = TEST_ENV.SUPABASE_PUBLISHABLE_KEY;
  let patchCalled = false;
  global.fetch = async (url, opts) => {
    if (opts.method === "GET") return new Response(makeBalance(10000), { status: 200 });
    if (opts.method === "PATCH") { patchCalled = true; return new Response("", { status: 200 }); }
    return new Response("", { status: 201 });
  };
  try {
    const res = await request(createApp())
      .post("/api/billing/purchase-tokens")
      .send({ amount: 5000 })
      .expect(201);
    assert.equal(res.body.purchased, 5000);
    assert.equal(res.body.tokens, 15000);
    assert.equal(patchCalled, true);
  } finally {
    delete global.fetch;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (savedPub !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = savedPub;
    else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  }
});

test("POST /api/billing/purchase-tokens — rejects zero amount", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedPub = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = TEST_ENV.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_ENV.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = TEST_ENV.SUPABASE_PUBLISHABLE_KEY;
  try {
    const res = await request(createApp())
      .post("/api/billing/purchase-tokens")
      .send({ amount: 0 })
      .expect(400);
    assert.equal(res.body.code, "BILLING_BAD_REQUEST");
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (savedPub !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = savedPub;
    else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  }
});
