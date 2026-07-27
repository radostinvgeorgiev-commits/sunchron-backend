import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createReadinessHandler,
  getReadinessStatus,
  getRuntimeVersion,
} from "../src/routes/health.js";

test("liveness version exposes the deployed commit without exposing secrets", () => {
  assert.deepEqual(
    getRuntimeVersion({
      npm_package_version: "1.2.3",
      APP_COMMIT_SHA: "abc123",
    }),
    { version: "1.2.3", commit: "abc123" },
  );
});

test("readiness requires the chat agent and a healthy OpenSearch cluster", async () => {
  const result = await getReadinessStatus({
    env: {
      AGENT_URL: "https://agent.example",
      AGENT_KEY: "secret",
      APP_COMMIT_SHA: "abc123",
    },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "green" } }),
      },
    }),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.commit, "abc123");
  assert.equal(result.checks.memory.status, "green");
});

test("readiness returns 503 when a required dependency is unavailable", async () => {
  const app = express();
  app.get(
    "/health/ready",
    createReadinessHandler({
      env: { AGENT_URL: "https://agent.example", AGENT_KEY: "secret" },
      loadOpenSearchClient: () => null,
    }),
  );

  const response = await request(app).get("/health/ready").expect(503);
  assert.equal(response.body.status, "not-ready");
  assert.equal(response.body.checks.memory.ready, false);
});

test("readiness rejects a red OpenSearch cluster", async () => {
  const result = await getReadinessStatus({
    env: { AGENT_URL: "https://agent.example", AGENT_KEY: "secret" },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "red" } }),
      },
    }),
  });

  assert.equal(result.status, "not-ready");
  assert.equal(result.checks.memory.status, "red");
});
