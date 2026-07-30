import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createBridgeDiagnosticsHandler,
  createReadinessHandler,
  getBridgeDiagnosticsStatus,
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

test("readiness accepts OpenAI as the primary chat provider", async () => {
  const result = await getReadinessStatus({
    env: {
      OPENAI_API_KEY: "secret",
      APP_COMMIT_SHA: "openai123",
    },
    loadOpenSearchClient: () => ({
      cluster: {
        health: async () => ({ body: { status: "green" } }),
      },
    }),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.checks.chatAgent.primaryProvider, "openai");
  assert.equal(result.checks.chatAgent.fallbackConfigured, false);
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

test("bridge diagnostics distinguish configuration, response and ChatGPT OAuth readiness", async () => {
  const result = await getBridgeDiagnosticsStatus({
    env: {
      MCP_ACCESS_TOKEN: "m".repeat(48),
      APP_COMMIT_SHA: "bridge123",
    },
    handleMcpRequest: async () => ({
      result: { serverInfo: { name: "synchron-x-memory" } },
    }),
  });

  assert.equal(result.status, "operational");
  assert.equal(result.commit, "bridge123");
  assert.equal(result.bridge.configured, true);
  assert.equal(result.bridge.reachable, true);
  assert.equal(result.bridge.responding, true);
  assert.equal(result.bridge.readOnly, true);
  assert.equal(result.bridge.authentication.chatgptOAuthReady, false);
  assert.equal(
    result.bridge.authentication.reason,
    "oauth-2.1-authorization-server-required",
  );
});

test("bridge diagnostics fail honestly when the token is missing", async () => {
  const app = express();
  app.get(
    "/health/bridge",
    createBridgeDiagnosticsHandler({
      env: {},
      handleMcpRequest: async () => ({
        result: { serverInfo: { name: "synchron-x-memory" } },
      }),
    }),
  );

  const response = await request(app).get("/health/bridge").expect(503);
  assert.equal(response.body.status, "incomplete");
  assert.equal(response.body.bridge.configured, false);
  assert.equal(response.body.bridge.responding, true);
  assert.equal(response.body.bridge.authentication.chatgptOAuthReady, false);
});

test("bridge diagnostics stop a blocked self-check within the configured timeout", async () => {
  const startedAt = Date.now();
  const result = await getBridgeDiagnosticsStatus({
    env: { MCP_ACCESS_TOKEN: "m".repeat(48) },
    handleMcpRequest: () => new Promise(() => {}),
    timeoutMs: 10,
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.bridge.configured, true);
  assert.equal(result.bridge.responding, false);
  assert.ok(Date.now() - startedAt < 1_000);
});
