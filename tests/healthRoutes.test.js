import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createReadinessHandler,
  createStorageBackupsHandler,
  createStorageDependenciesHandler,
  getReadinessStatus,
  getRuntimeVersion,
} from "../src/routes/health.js";

test("liveness exposes the deployed commit without secrets", () => {
  assert.deepEqual(getRuntimeVersion({ npm_package_version: "1.2.3", APP_COMMIT_SHA: "abc123" }), {
    version: "1.2.3",
    commit: "abc123",
  });
});

test("readiness uses Firestore and the selected AI provider only", async () => {
  const result = await getReadinessStatus({
    env: {
      AI_CORE_PROVIDER: "grok",
      GROK_API_KEY: "secret",
      MEMORY_BACKEND: "firestore",
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
      FIRESTORE_DATABASE_ID: "(default)",
      APP_COMMIT_SHA: "firestore123",
    },
    loadFirestoreMemoryStore: () => ({ probe: async () => ({ status: "green" }) }),
    loadMemoryVerificationStatus: () => ({ status: "works", passedSteps: 9 }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.memory.backend, "firestore");
  assert.equal(result.checks.chatAgent.primaryProvider, "grok");
  assert.equal(result.checks.memoryAcceptance.passedSteps, 9);
  assert.equal("opensearch" in result.checks, false);
});

test("readiness fails closed when Firestore probe fails", async () => {
  const result = await getReadinessStatus({
    env: { AI_CORE_PROVIDER: "openai", OPENAI_API_KEY: "secret", MEMORY_BACKEND: "firestore", GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9" },
    loadFirestoreMemoryStore: () => ({ probe: async () => { throw new Error("denied"); } }),
  });
  assert.equal(result.status, "not-ready");
  assert.equal(result.checks.memory.ready, false);
});

test("storage endpoints expose Firestore-only reports", async () => {
  const app = express();
  app.get("/dependencies", createStorageDependenciesHandler({
    loadStatus: async () => ({ status: "healthy", checks: { firestore: { status: "healthy" } } }),
  }));
  app.get("/backups", createStorageBackupsHandler({
    loadStatus: async () => ({ status: "not-required", checkedAt: "now", checks: { firestore: { status: "managed" } } }),
  }));
  const dependencies = await request(app).get("/dependencies").expect(200);
  const backups = await request(app).get("/backups").expect(200);
  assert.equal(dependencies.body.checks.firestore.status, "healthy");
  assert.equal(backups.body.checks.firestore.status, "managed");
  assert.equal("opensearch" in backups.body.checks, false);
});
