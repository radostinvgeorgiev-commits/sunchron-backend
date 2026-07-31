import assert from "node:assert/strict";
import test from "node:test";

import {
  getMemoryStartupVerificationStatus,
  resetMemoryStartupVerificationForTests,
  startMemoryStartupVerification,
} from "../src/services/memoryStartupVerificationService.js";

function report() {
  return {
    status: "works",
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: "2026-07-31T10:00:01.000Z",
    isolated: true,
    realMemoryUnchanged: true,
    cleanupCompleted: true,
    steps: [{ status: "passed" }, { status: "passed" }],
  };
}

test.beforeEach(() => resetMemoryStartupVerificationForTests());

test("production startup verification exposes only safe proof fields", async () => {
  const status = await startMemoryStartupVerification({
    ownerId: "radko",
    verifyDeleteGuard: async () => true,
    retryDelaysMs: [0],
    runAcceptanceTest: async () => report(),
  });

  assert.deepEqual(status, {
    status: "works",
    ready: true,
    attempts: 1,
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: "2026-07-31T10:00:01.000Z",
    isolated: true,
    realMemoryUnchanged: true,
    cleanupCompleted: true,
    passedSteps: 2,
    errorCode: null,
  });
  assert.equal(getMemoryStartupVerificationStatus(), status);
  assert.doesNotMatch(JSON.stringify(status), /radko/u);
});

test("production startup verification retries a transient OpenSearch failure", async () => {
  let calls = 0;
  const waits = [];
  const status = await startMemoryStartupVerification({
    ownerId: "radko",
    verifyDeleteGuard: async () => true,
    retryDelaysMs: [0, 20],
    wait: async (delayMs) => waits.push(delayMs),
    runAcceptanceTest: async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("temporary"), {
          code: "MEMORY_UNAVAILABLE",
        });
      }
      return report();
    },
  });

  assert.equal(status.status, "works");
  assert.equal(status.attempts, 2);
  assert.deepEqual(waits, [20]);
});

test("production startup verification fails closed without exposing an error message", async () => {
  const status = await startMemoryStartupVerification({
    ownerId: "radko",
    verifyDeleteGuard: async () => true,
    retryDelaysMs: [0],
    runAcceptanceTest: async () => {
      throw Object.assign(new Error("secret internal detail"), {
        code: "MEMORY_ACCEPTANCE_FAILED",
      });
    },
  });

  assert.equal(status.status, "failed");
  assert.equal(status.ready, false);
  assert.equal(status.errorCode, "MEMORY_ACCEPTANCE_FAILED");
  assert.doesNotMatch(JSON.stringify(status), /secret internal detail/u);
});
