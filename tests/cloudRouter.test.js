import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import cloudRouter from "../src/routes/cloudRouter.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/cloud", cloudRouter);
  return app;
}

test("legacy cloud memory actions are explicitly unavailable", async () => {
  const response = await request(createApp())
    .post("/cloud")
    .send({
      module: "memory",
      action: "write_memory",
      params: { data: "private text" },
    })
    .expect(410);

  assert.equal(response.body.code, "LEGACY_CLOUD_ROUTE_REMOVED");
  assert.equal(JSON.stringify(response.body).includes("private text"), false);
});

test("cloud heartbeat remains available without echoing request data", async () => {
  const response = await request(createApp())
    .post("/cloud")
    .send({
      module: "system",
      action: "heartbeat",
      privateValue: "do-not-echo",
    })
    .expect(200);

  assert.equal(response.body.status, "ok");
  assert.equal(JSON.stringify(response.body).includes("do-not-echo"), false);
});
