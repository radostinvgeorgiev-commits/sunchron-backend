import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createWorkspacesRouter } from "../src/routes/workspacesRouter.js";

function appWithOwner(options = {}, ownerId = "supabase:user-1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: ownerId };
    next();
  });
  app.use("/api/workspaces", createWorkspacesRouter(options));
  return app;
}

test("workspace route always binds reads to the verified owner", async () => {
  let receivedOwner = "";
  const app = appWithOwner({
    load: async (ownerId) => {
      receivedOwner = ownerId;
      return { state: { mode: "chat" }, persisted: false };
    },
  });

  const response = await request(app).get("/api/workspaces").expect(200);
  assert.equal(receivedOwner, "supabase:user-1");
  assert.equal(response.body.persisted, false);
});

test("workspace route ignores owner ids supplied by the client", async () => {
  let received = null;
  const app = appWithOwner({
    save: async (ownerId, state) => {
      received = { ownerId, state };
      return { state, persisted: true };
    },
  });

  await request(app)
    .put("/api/workspaces")
    .send({ ownerId: "another-user", state: { mode: "work" } })
    .expect(200);

  assert.equal(received.ownerId, "supabase:user-1");
  assert.deepEqual(received.state, { mode: "work" });
});
