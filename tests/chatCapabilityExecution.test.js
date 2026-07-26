import assert from "node:assert/strict";
import test from "node:test";

import {
  detectCapabilityRequests,
  executeDetectedCapabilities,
  extractConfirmedMemoryWriteCommands,
} from "../src/routes/chat.js";

test("detects multiple capability subtasks in one message", () => {
  const requests = detectCapabilityRequests(
    "Провери календара и GitHub commit-ите от днес.",
  );
  assert.deepEqual(requests, [
    { capability: "calendar.read", action: "calendar.read" },
    { capability: "code.read", action: "github.read" },
  ]);
});

test("executes all detected subtasks sequentially even after a failure", async () => {
  const calls = [];
  const results = await executeDetectedCapabilities(
    "Провери календара и GitHub.",
    async (capability, _options) => {
      calls.push(capability);
      if (capability === "calendar.read") {
        throw new Error("calendar temporary failure");
      }
      return {
        output: "GitHub result",
        permission: { decision: "allow" },
        tool: { id: "github-read" },
      };
    },
  );

  assert.deepEqual(calls, ["calendar.read", "code.read"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].error.message, "calendar temporary failure");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].result.output, "GitHub result");
});

test("requires explicit memory-write confirmation prefix", () => {
  const commands = extractConfirmedMemoryWriteCommands(
    "Потвърждавам запис в постоянната памет: Запомни, че проектът е SYNCHRON-X.",
  );
  assert.deepEqual(commands, [
    { fact: "проектът е SYNCHRON-X", scope: "personal" },
  ]);
  assert.deepEqual(
    extractConfirmedMemoryWriteCommands(
      "Запомни, че проектът е SYNCHRON-X.",
    ),
    [],
  );
});
