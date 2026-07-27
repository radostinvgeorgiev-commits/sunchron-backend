import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import confirmedActionsRouter from "../src/routes/confirmedActionsRouter.js";
import googleDriveRouter from "../src/routes/googleDriveRouter.js";
import webSearchRouter from "../src/routes/webSearchRouter.js";
import {
  listAuditEvents,
  resetAuditFallbackForTests,
} from "../src/services/permissionService.js";

function clearOpenSearchEnv() {
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
  delete process.env.OPENSEARCH_HOST;
  delete process.env.OPENSEARCH_PORT;
}

test.beforeEach(() => {
  clearOpenSearchEnv();
  resetAuditFallbackForTests();
});

test("web search записва унифициран audit при успех", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Проверен отговор." }],
          },
        ],
      }),
      { status: 200 },
    );

  const app = express();
  app.use(express.json());
  app.use("/search", webSearchRouter);

  try {
    const response = await request(app)
      .post("/search/ai")
      .send({ query: "Какво ново?" });
    assert.equal(response.status, 200);
    const [event] = await listAuditEvents(1);
    assert.equal(event.action, "web.read");
    assert.equal(event.outcome, "succeeded");
    assert.equal(event.resource, "POST /search/ai");
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("google direct route записва унифициран audit при грешка", async () => {
  const app = express();
  app.use("/api/google", googleDriveRouter);

  const response = await request(app).get("/api/google/files");
  assert.equal(response.status, 401);

  const [event] = await listAuditEvents(1);
  assert.equal(event.action, "drive.read");
  assert.equal(event.outcome, "failed");
  assert.equal(event.resource, "GET /api/google/files");
});

test("confirmed actions записва унифициран audit при request", async () => {
  const app = express();
  app.use(express.json());
  app.use("/confirmed-actions", confirmedActionsRouter);

  const response = await request(app)
    .post("/confirmed-actions/request")
    .send({
      sessionId: "sess-1",
      action: "github.write:create_pr",
      resource: { repository: "radostinvgeorgiev-commits/sunchron-backend", head: "feat", base: "main" },
      params: { title: "PR title" },
    });

  assert.equal(response.status, 201);
  const [event] = await listAuditEvents(1);
  assert.equal(event.action, "github.write:create_pr");
  assert.equal(event.outcome, "requested");
});
