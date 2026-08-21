import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeOrchestratorRequests,
  orchestrateTask,
} from "../src/services/taskOrchestratorService.js";

test("orchestrator keeps deterministic requests and adds distinct planned steps", () => {
  const fallback = [{ capability: "code.write", message: "task" }];
  const merged = mergeOrchestratorRequests(fallback, [
    { capability: "code.write", message: "weaker duplicate" },
    { capability: "code.read", message: "inspect" },
  ]);
  assert.deepEqual(merged, [
    ...fallback,
    { capability: "code.read", message: "inspect" },
  ]);
});

test("orchestrator plans, routes and executes a real multi-step task", async () => {
  const events = [];
  const execution = await orchestrateTask({
    message: "Подобри интерфейса.",
    fallbackRequests: [{ capability: "code.write", action: "github.write" }],
    planningAllowed: true,
    shouldPlanFn: () => true,
    planFn: async () => [
      { capability: "code.read", action: "github.read" },
    ],
    routeRequests: (requests) => requests,
    executeFn: async (capability) => ({
      tool: { id: capability },
      permission: { decision: "allow" },
      requiresConfirmation: capability === "code.write",
      output: capability,
    }),
    executionContext: { sessionId: "session-1", prepareConfirmation: true },
    notify: (event) => events.push(event),
  });

  assert.equal(execution.plannerUsed, true);
  assert.equal(execution.task.status, "waiting_confirmation");
  assert.deepEqual(
    execution.requests.map(({ capability }) => capability),
    ["code.write", "code.read"],
  );
  assert.ok(events.some(({ status }) => status === "planning"));
});

test("orchestrator exposes the durable run context after planning", async () => {
  const events = [];
  const execution = await orchestrateTask({
    message: "Провери статуса.",
    fallbackRequests: [{ capability: "code.read" }],
    routeRequests: (requests) => requests,
    executeFn: async (capability) => ({
      tool: { id: capability },
      permission: { decision: "allow" },
      requiresConfirmation: false,
      output: "ok",
    }),
    onPlan: async ({ requests }) => {
      events.push({ phase: "planned", count: requests.length });
      return { taskRunId: "run-123" };
    },
    notify: (event) => events.push(event),
  });

  assert.equal(execution.taskRunId, "run-123");
  assert.deepEqual(events[1], { phase: "planned", count: 1 });
});
