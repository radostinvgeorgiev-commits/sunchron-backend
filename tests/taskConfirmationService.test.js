import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfirmation,
  createTaskConfirmation,
  resetConfirmationsForTests,
} from "../src/services/confirmationService.js";
import {
  confirmTaskWrite,
  extractTaskConfirmationId,
} from "../src/services/taskConfirmationService.js";

test.beforeEach(() => resetConfirmationsForTests());

test("task confirmation executes each prepared operation once", async () => {
  const calls = [];
  const group = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "session-1",
    taskId: "task-1",
    items: [
      {
        confirmationId: "cloud-1",
        capability: "infrastructure.googlecloud.write",
        toolId: "google-cloud-write",
      },
      {
        confirmationId: "github-1",
        capability: "github.pull-request.merge",
        toolId: "github-confirmed-write",
      },
    ],
    createConfirmation,
  });

  const result = await confirmTaskWrite({
    ownerId: "owner-1",
    sessionId: "session-1",
    taskConfirmationId: group.confirmationId,
    taskId: "task-1",
    executeCapability: async (capability, input, options) => {
      calls.push({ capability, input, options });
      return { output: "ok" };
    },
    confirmCodeTask: async () => {
      throw new Error("code task is not expected in this fixture");
    },
  });

  assert.equal(result.results.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((item) => item.input.confirmationId), [
    "cloud-1",
    "github-1",
  ]);
  assert.deepEqual(calls.map((item) => item.options), [
    { confirmed: true, env: process.env },
    { confirmed: true, env: process.env },
  ]);

  await assert.rejects(
    () =>
      confirmTaskWrite({
        ownerId: "owner-1",
        sessionId: "session-1",
        taskConfirmationId: group.confirmationId,
        taskId: "task-1",
        executeCapability: async () => ({ output: "should not run" }),
      }),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("task confirmation parser accepts only the exact owner command", () => {
  assert.equal(
    extractTaskConfirmationId(
      "Потвърждавам AI CORE задача: 12345678-1234-1234-1234-123456789012",
    ),
    "12345678-1234-1234-1234-123456789012",
  );
  assert.equal(extractTaskConfirmationId("да, изпълни"), null);
});
