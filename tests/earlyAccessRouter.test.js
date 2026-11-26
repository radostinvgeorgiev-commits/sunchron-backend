import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  createEarlyAccessAdminRouter,
  createEarlyAccessRouter,
} from "../src/routes/earlyAccessRouter.js";

process.env.NODE_ENV = "test";
const { default: app } = await import("../server.js");

test("early access requires consent and saves normalized emails only once", async () => {
  const entries = new Map();
  const testApp = express().use(
    "/api/early-access",
    createEarlyAccessRouter({
      getStore: () => ({
        async set(_collection, id, data, options) {
          assert.deepEqual(options, { createOnly: true });
          if (entries.has(id)) {
            throw Object.assign(new Error("duplicate"), {
              upstreamErrorStatus: "ALREADY_EXISTS",
            });
          }
          entries.set(id, data);
        },
      }),
    }),
  );
  await request(testApp)
    .post("/api/early-access")
    .type("form")
    .send({ email: "person@example.com" })
    .expect(303)
    .expect("Location", "/plans?request=invalid#early-access");
  assert.equal(entries.size, 0);

  for (const email of [" Person@Example.com ", "person@example.com"]) {
    await request(testApp)
      .post("/api/early-access")
      .type("form")
      .send({ email, consent: "yes", source: "chatgpt" })
      .expect(303)
      .expect("Location", "/plans?request=received#early-access");
  }
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0].email, "person@example.com");
  assert.equal([...entries.values()][0].source, "chatgpt");
});

test("admin list escapes saved text and is private on the real server", async () => {
  const testApp = express().use(
    "/admin/early-access",
    createEarlyAccessAdminRouter({
      getStore: () => ({
        query: async () => [
          {
            data: {
              email: "<script>@example.com",
              submittedAt: "2026-11-20T12:00:00Z",
            },
          },
        ],
      }),
    }),
  );
  const list = await request(testApp).get("/admin/early-access").expect(200);
  assert.match(list.text, /&lt;script&gt;@example\.com/u);
  assert.doesNotMatch(list.text, /<script>/u);
  assert.equal(list.headers["cache-control"], "private, no-store");

  await request(app).get("/admin/early-access").expect(401);
  await request(app)
    .get("/plans")
    .expect(200)
    .expect(/Въпрос за услугата/u);
});
