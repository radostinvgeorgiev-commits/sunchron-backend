import assert from "node:assert/strict";
import test from "node:test";

import { executeTaskPlan } from "../src/services/taskExecutionService.js";

function result(overrides = {}) {
  return {
    output: "Проверен резултат",
    requiresConfirmation: false,
    permission: { decision: "allow" },
    tool: { id: "test-tool" },
    ...overrides,
  };
}

test("task execution completes safe steps and reports verified status", async () => {
  const events = [];
  const audits = [];
  const execution = await executeTaskPlan({
    message: "Провери",
    requests: [
      { capability: "code.read", action: "github.read", message: "Провери" },
      { capability: "web.search", action: "web.read", message: "Потърси" },
    ],
    executeFn: async () => result(),
    executionContext: { sessionId: "sess-test" },
    notify: (event) => events.push(event),
    audit: async (event) => audits.push(event),
  });

  assert.equal(execution.task.status, "completed");
  assert.equal(execution.task.verified, true);
  assert.equal(execution.task.successfulSteps, 2);
  assert.equal(execution.task.failedSteps, 0);
  assert.equal(audits.length, 2);
  assert.equal(events.at(-1).status, "completed");
});

test("task execution stops at the existing confirmation boundary", async () => {
  const execution = await executeTaskPlan({
    message: "Промени кода",
    requests: [
      { capability: "code.write", action: "github.write", message: "Промени" },
    ],
    executeFn: async () =>
      result({
        requiresConfirmation: true,
        permission: { decision: "confirm" },
      }),
    executionContext: {
      sessionId: "sess-test",
      prepareConfirmation: true,
    },
  });

  assert.equal(execution.task.status, "waiting_confirmation");
  assert.equal(execution.task.verified, false);
  assert.equal(execution.task.steps[0].status, "waiting_confirmation");
});

test("task execution passes exact operation input to confirmed capabilities", async () => {
  let captured;
  await executeTaskPlan({
    message: "Стартирай Cloud Build.",
    requests: [
      {
        capability: "infrastructure.googlecloud.write",
        action: "infrastructure.write",
        operation: "run_cloud_build_trigger",
        input: { commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a", branch: "main" },
      },
    ],
    executeFn: async (_capability, input) => {
      captured = input;
      return result({ requiresConfirmation: true, permission: { decision: "confirm" } });
    },
    executionContext: { sessionId: "sess-test", prepareConfirmation: true },
  });

  assert.equal(captured.operation, "run_cloud_build_trigger");
  assert.deepEqual(captured.input, {
    commitSha: "6dbfb750813c47cca439db5bc3e9a3debbbb5a3a",
    branch: "main",
  });
});

test("task execution creates one scoped confirmation for multiple prepared writes", async () => {
  let groupInput;
  const execution = await executeTaskPlan({
    message: "Направи две свързани промени",
    requests: [
      { capability: "code.write", action: "github.write" },
      { capability: "infrastructure.googlecloud.write", action: "infrastructure.write" },
    ],
    executeFn: async (capability) =>
      result({
        requiresConfirmation: true,
        permission: { decision: "confirm" },
        tool: {
          id: capability === "code.write" ? "github-write" : "google-cloud-write",
        },
        metadata: {
          confirmationId:
            capability === "code.write" ? "code-confirmation" : "cloud-confirmation",
          confirmationType: capability === "code.write" ? "code-task" : "capability",
        },
      }),
    executionContext: {
      ownerId: "owner-1",
      sessionId: "session-1",
      prepareConfirmation: true,
      createTaskConfirmation: async (input) => {
        groupInput = input;
        return {
          confirmationId: "task-confirmation",
          expiresAt: Date.now() + 60_000,
          items: input.items,
        };
      },
    },
  });

  assert.equal(execution.task.status, "waiting_confirmation");
  assert.equal(execution.task.confirmationId, "task-confirmation");
  assert.equal(execution.taskConfirmation.confirmationId, "task-confirmation");
  assert.equal(groupInput.items.length, 2);
  assert.deepEqual(
    groupInput.items.map(({ confirmationId, confirmationType }) => [
      confirmationId,
      confirmationType,
    ]),
    [
      ["code-confirmation", "code-task"],
      ["cloud-confirmation", "capability"],
    ],
  );
});

test("task execution reports partial results without hiding failures", async () => {
  let call = 0;
  const execution = await executeTaskPlan({
    message: "Направи две проверки",
    requests: [
      { capability: "code.read", action: "github.read" },
      { capability: "files.read", action: "drive.read" },
    ],
    executeFn: async () => {
      call += 1;
      if (call === 2) {
        const error = new Error("Няма връзка");
        error.code = "NOT_CONNECTED";
        throw error;
      }
      return result();
    },
  });

  assert.equal(execution.task.status, "partial");
  assert.equal(execution.task.verified, false);
  assert.equal(execution.task.successfulSteps, 1);
  assert.equal(execution.task.failedSteps, 1);
  assert.equal(execution.task.steps[1].error, "NOT_CONNECTED");
});

test("audit storage failure never changes a successful task result", async () => {
  const execution = await executeTaskPlan({
    message: "Провери",
    requests: [{ capability: "code.read", action: "github.read" }],
    executeFn: async () => result(),
    audit: async () => {
      throw new Error("Audit storage unavailable");
    },
  });

  assert.equal(execution.task.status, "completed");
  assert.equal(execution.task.successfulSteps, 1);
  assert.equal(execution.results.length, 1);
});
