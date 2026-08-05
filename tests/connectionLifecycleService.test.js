import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRetryDelay,
  createConnectionLifecycleManager,
} from "../src/services/connectionLifecycleService.js";

test("retry delay applies exponential backoff with bounded jitter", () => {
  const delay = calculateRetryDelay(
    3,
    { baseDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.2 },
    () => 1,
  );
  assert.equal(delay, 480);
});

test("connection lifecycle retries transient failures and becomes ready", async () => {
  const events = [];
  const waits = [];
  let attempts = 0;
  const manager = createConnectionLifecycleManager({
    name: "bridge",
    logger: (event, fields) => events.push({ event, fields }),
    wait: async (delay) => waits.push(delay),
    random: () => 0.5,
    options: { timeoutMs: 50, maxRetries: 2, baseDelayMs: 10, jitterRatio: 0 },
    connect: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporary");
        error.code = "TRANSIENT_FAILURE";
        throw error;
      }
      return { ok: true };
    },
  });

  const result = await manager.open();
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(manager.getStatus().phase, "ready");
  assert.equal(events.some(({ event }) => event === "connection.retry"), true);
});

test("connection lifecycle enters cooldown after max retries", async () => {
  const manager = createConnectionLifecycleManager({
    name: "bridge",
    wait: async () => {},
    random: () => 0.5,
    options: { timeoutMs: 10, maxRetries: 1, baseDelayMs: 5, jitterRatio: 0, cooldownMs: 99 },
    connect: async () => {
      throw Object.assign(new Error("offline"), { code: "OFFLINE" });
    },
  });

  const result = await manager.open();
  assert.equal(result.ok, false);
  assert.equal(manager.getStatus().phase, "cooldown");
  assert.equal(manager.getStatus().nextDelayMs, 99);
});
