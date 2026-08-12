import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlightCache,
  inspectStorageBackups,
  inspectStorageDependencies,
} from "../src/services/storageHealthService.js";

const ENV = {
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
};

test("storage health checks only Firestore memory and operational stores", async () => {
  const report = await inspectStorageDependencies({
    env: ENV,
    loadFirestoreMemoryStore: () => ({ probe: async () => ({ status: "green" }) }),
    loadFirestoreOperationalStore: () => ({ backend: "firestore" }),
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(report.status, "healthy");
  assert.equal(report.checks.firestore.backend, "firestore");
  assert.equal(report.checks.firestore.operational, "healthy");
  assert.equal("opensearch" in report.checks, false);
  assert.equal("supabase" in report.checks, false);
});

test("Firestore health fails closed when the probe fails", async () => {
  const report = await inspectStorageDependencies({
    env: ENV,
    loadFirestoreMemoryStore: () => ({
      probe: async () => {
        const error = new Error("unavailable");
        error.code = "FIRESTORE_CREDENTIALS_UNAVAILABLE";
        throw error;
      },
    }),
    loadFirestoreOperationalStore: () => ({ backend: "firestore" }),
  });
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.firestore.errorCode, "FIRESTORE_CREDENTIALS_UNAVAILABLE");
});

test("Firestore backup status is managed by Google Cloud", async () => {
  const report = await inspectStorageBackups({ now: () => new Date("2026-08-12T00:00:00.000Z") });
  assert.equal(report.status, "not-required");
  assert.equal(report.checks.firestore.status, "managed");
  assert.equal(report.checks.firestore.restoreTested, false);
});

test("single-flight cache shares a Firestore health request", async () => {
  let calls = 0;
  const load = createSingleFlightCache(async () => {
    calls += 1;
    return { status: "healthy" };
  }, { ttlMs: 1_000, now: () => 1_000 });
  const [a, b] = await Promise.all([load(), load()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
