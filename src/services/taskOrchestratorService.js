import {
  planCapabilities,
  shouldUseAgentPlanner,
} from "./agentPlannerService.js";
import { executeTaskPlan } from "./taskExecutionService.js";

function identity(value) {
  return value;
}

export function mergeOrchestratorRequests(
  fallbackRequests = [],
  plannedRequests = [],
) {
  const fallback = Array.isArray(fallbackRequests) ? fallbackRequests : [];
  const planned = Array.isArray(plannedRequests) ? plannedRequests : [];
  const merged = [...fallback];
  const fallbackCapabilities = new Set(
    fallback.map(({ capability }) => capability).filter(Boolean),
  );
  const seen = new Set(
    merged.map(
      ({ capability, message, scope }) =>
        `${capability || ""}\u0000${message || ""}\u0000${scope || ""}`,
    ),
  );

  for (const request of planned) {
    if (!request?.capability || fallbackCapabilities.has(request.capability)) {
      continue;
    }
    const key = `${request.capability}\u0000${request.message || ""}\u0000${request.scope || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(request);
  }
  return merged;
}

export async function orchestrateTask({
  message,
  fallbackRequests = [],
  planningAllowed = false,
  plannerContext = {},
  planFn = planCapabilities,
  shouldPlanFn = shouldUseAgentPlanner,
  normalizeRequests = identity,
  routeRequests = identity,
  executeFn,
  executionContext = {},
  notify,
  audit,
  onPlannerError,
  onPlan,
} = {}) {
  const fallback = normalizeRequests(fallbackRequests);
  let requests = fallback;
  let plannerUsed = false;
  let plannerErrorCode = null;

  notify?.({
    status: "planning",
    message: "Проверявам задачата и избирам нужните инструменти…",
  });

  if (planningAllowed && shouldPlanFn(message, fallback)) {
    try {
      const planned = normalizeRequests(
        await planFn({ ...plannerContext, message }),
      );
      requests = mergeOrchestratorRequests(fallback, planned);
      plannerUsed = true;
    } catch (error) {
      plannerErrorCode = error?.code || "TASK_PLANNER_FAILED";
      onPlannerError?.(error);
      requests = fallback;
    }
  }

  requests = normalizeRequests(routeRequests(requests));
  let taskRunContext = null;
  if (typeof onPlan === "function") {
    try {
      taskRunContext =
        (await onPlan({
          message,
          requests: Object.freeze([...requests]),
          plannerUsed,
          plannerErrorCode,
        })) || null;
    } catch (error) {
      onPlannerError?.(error);
    }
  }
  const execution = await executeTaskPlan({
    message,
    requests,
    executeFn,
    executionContext,
    notify,
    audit,
  });

  return Object.freeze({
    ...execution,
    requests: Object.freeze([...requests]),
    plannerUsed,
    plannerErrorCode,
    ...(taskRunContext && typeof taskRunContext === "object"
      ? taskRunContext
      : {}),
  });
}
