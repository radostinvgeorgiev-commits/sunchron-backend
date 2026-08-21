import assert from "node:assert/strict";
import test from "node:test";

import {
  createStorageReportHandler,
  getReadinessStatus,
  getRuntimeVersion,
  resolveStorageBackupCacheTtlMs,
} from "../src/routes/health.js";

test("liveness version exposes only the deployed version and commit", () => {
  assert.deepEqual(
    getRuntimeVersion({ npm_package_version: "1.2.3", APP_COMMIT_SHA: "abc123" }),
    { version: "1.2.3", commit: "abc123" },
  );
});

test("readiness accepts the selected AI provider and a healthy Firestore probe", async () => {
  const result = await getReadinessStatus({
    env: {
      NODE_ENV: "test",
      OPENAI_API_KEY: "key",
      MEMORY_BACKEND: "firestore",
      GOOGLE_CLOUD_PROJECT: "project-1",
    },
    loadFirestoreMemoryStore: () => ({
      probe: async () => ({ status: "green" }),
    }),
    loadMemoryVerificationStatus: () => ({ status: "not-required" }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.memory.backend, "firestore");
  assert.equal(result.checks.chatAgent.primaryProvider, "openai");
});

test("readiness rejects non-Firestore memory runtime", async () => {
  const result = await getReadinessStatus({
    env: { NODE_ENV: "test", OPENAI_API_KEY: "key", MEMORY_BACKEND: "opensearch" },
    loadMemoryVerificationStatus: () => ({ status: "not-required" }),
  });
  assert.equal(result.status, "not-ready");
  assert.equal(result.checks.memory.status, "invalid-backend");
});

test("unverified Firestore backup status uses a short cache", () => {
  assert.equal(resolveStorageBackupCacheTtlMs({ status: "unverified" }), 15_000);
});

test("storage report exposes the explicit untested restore boundary", async () => {
  const response = {};
  const res = {
    setHeader() {},
    status(code) {
      response.status = code;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  const handler = createStorageReportHandler({
    loadDependencies: async () => ({ status: "healthy", checks: {} }),
    loadBackups: async () => ({
      status: "unverified",
      checkedAt: "2026-08-21T14:00:00.000Z",
      checks: {
        firestore: {
          status: "unverified",
          errorCode: "FIRESTORE_BACKUP_STATUS_NOT_VISIBLE_TO_RUNTIME",
        },
      },
    }),
    now: () => new Date("2026-08-21T14:00:01.000Z"),
  });

  await handler({}, res);

  assert.equal(response.status, 200);
  assert.equal(response.body.backups.checks.firestore.readOnlyCheck, true);
  assert.equal(response.body.backups.checks.firestore.restoreTested, false);
  assert.equal(response.body.backups.checks.firestore.provesRestore, false);
});
