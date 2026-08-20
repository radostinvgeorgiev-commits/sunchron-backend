import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlightCache,
  inspectStorageBackups,
  inspectStorageDependencies,
} from "../src/services/storageHealthService.js";

test("storage health verifies Firestore and Identity Platform", async () => {
  const report = await inspectStorageDependencies({
    loadFirestoreStore: () => ({ probe: async () => ({ status: "green" }) }),
    getAuthStatus: () => ({
      configured: true,
      provider: "identity-platform",
      registrationEnabled: true,
    }),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(report.status, "healthy");
  assert.equal(report.checks.firestore.status, "healthy");
  assert.equal(report.checks.identityPlatform.status, "healthy");
  assert.equal(JSON.stringify(report).includes("secret"), false);
});

test("storage health fails closed when Firestore is unavailable", async () => {
  const report = await inspectStorageDependencies({
    loadFirestoreStore: () => ({
      probe: async () => {
        throw Object.assign(new Error("private"), { code: "FIRESTORE_DOWN" });
      },
    }),
    getAuthStatus: () => ({ configured: true, provider: "identity-platform" }),
  });
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks.firestore.errorCode, "FIRESTORE_DOWN");
  assert.doesNotMatch(JSON.stringify(report), /private/u);
});

test("backup status is honest and points only to Firestore", async () => {
  const report = await inspectStorageBackups({
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(report.status, "unverified");
  assert.deepEqual(Object.keys(report.checks), ["firestore"]);
  assert.equal(report.checks.firestore.restoreTested, false);
});

test("single-flight cache coalesces concurrent checks", async () => {
  let calls = 0;
  const cached = createSingleFlightCache(
    async () => {
      calls += 1;
      return { status: "healthy" };
    },
    { ttlMs: 1_000, now: () => 100 },
  );
  const [a, b] = await Promise.all([cached(), cached()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});
