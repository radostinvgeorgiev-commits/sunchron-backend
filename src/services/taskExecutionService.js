import { randomUUID } from "node:crypto";
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";

const TERMINAL_STATUSES = new Set([
  "completed",
  "partial",
  "failed",
  "waiting_confirmation",
]);

function safeNotify(notify, event) {
  if (typeof notify !== "function") return;
  try {
    notify(Object.freeze({ ...event }));
  } catch (error) {
    logSafeError("[TaskExecution] Status notification failed", error);
  }
}

async function safeAudit(audit, event) {
  if (typeof audit !== "function") return;
  try {
    await audit(event);
  } catch (error) {
    logSafeError("[TaskExecution] Audit write failed", error);
  }
}

function finalStatus(results) {
  if (!results.length) return "completed";
  const successful = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  const waiting = successful.some(
    (item) => item.result?.requiresConfirmation === true,
  );

  if (waiting) return failed.length ? "partial" : "waiting_confirmation";
  if (successful.length && failed.length) return "partial";
  if (successful.length) return "completed";
  return "failed";
}

function statusMessage(status) {
  if (status === "completed") return "Задачата е изпълнена и проверена.";
  if (status === "partial") return "Задачата е изпълнена частично.";
  if (status === "waiting_confirmation") {
    return "Задачата чака конкретно потвърждение.";
  }
  return "Задачата не можа да бъде изпълнена.";
}

export async function executeTaskPlan({
  message,
  requests,
  executeFn,
  executionContext = {},
  notify,
  audit,
}) {
  if (typeof executeFn !== "function") {
    throw new TypeError("Task Execution: липсва изпълнима функция.");
  }

  const taskId = randomUUID();
  const plannedRequests = Array.isArray(requests) ? requests : [];
  const { prepareConfirmation = false, ...capabilityInputContext } =
    executionContext;
  const results = [];

  safeNotify(notify, {
    taskId,
    status: "executing",
    message:
      plannedRequests.length === 0
        ? "Задачата не изисква външен инструмент."
        : plannedRequests.length === 1
          ? "Изпълнявам задачата с избрания инструмент…"
          : `Изпълнявам ${plannedRequests.length} проверени стъпки…`,
    totalSteps: plannedRequests.length,
  });

  for (const [index, request] of plannedRequests.entries()) {
    const stepNumber = index + 1;
    const requestMessage = request.message || message;
    safeNotify(notify, {
      taskId,
      status: "executing",
      message: `Стъпка ${stepNumber} от ${plannedRequests.length}: ${request.capability}`,
      step: stepNumber,
      totalSteps: plannedRequests.length,
      capability: request.capability,
    });

    try {
      const result = await executeFn(
        request.capability,
        {
          message: requestMessage,
          scope: request.scope,
          ...(request.operation ? { operation: request.operation } : {}),
          ...(request.input && typeof request.input === "object"
            ? { input: request.input }
            : {}),
          ...capabilityInputContext,
        },
        { prepareConfirmation },
      );
      results.push({ status: "fulfilled", request, result });
      await safeAudit(audit, {
        action: request.action,
        decision: result.permission.decision,
        outcome: result.requiresConfirmation ? "requested" : "succeeded",
        resource: result.tool.id,
        sessionId: capabilityInputContext.sessionId,
      });
    } catch (error) {
      results.push({ status: "rejected", request, error });
      await safeAudit(audit, {
        action: request.action,
        decision: "deny",
        outcome: "failed",
        resource: request.capability,
        details: safeErrorCode(error, "TASK_EXECUTION_FAILED"),
        sessionId: capabilityInputContext.sessionId,
      });
    }
  }

  const status = finalStatus(results);
  const successfulSteps = results.filter(
    (item) => item.status === "fulfilled",
  ).length;
  const failedSteps = results.length - successfulSteps;
  const task = Object.freeze({
    id: taskId,
    status,
    verified:
      status === "completed" &&
      results.every(
        (item) =>
          item.status === "fulfilled" &&
          item.result?.requiresConfirmation !== true,
      ),
    totalSteps: results.length,
    successfulSteps,
    failedSteps,
    steps: Object.freeze(
      results.map((item) =>
        Object.freeze({
          capability: item.request.capability,
          status:
            item.status === "fulfilled"
              ? item.result?.requiresConfirmation
                ? "waiting_confirmation"
                : "completed"
              : "failed",
          tool: item.result?.tool?.id || null,
          error:
            item.status === "rejected"
              ? item.error?.code || "EXECUTION_FAILED"
              : null,
        }),
      ),
    ),
  });

  if (!TERMINAL_STATUSES.has(task.status)) {
    throw new Error("Task Execution: задачата няма краен статус.");
  }
  if (plannedRequests.length > 0) {
    safeNotify(notify, {
      taskId,
      status: task.status,
      message: statusMessage(task.status),
      totalSteps: task.totalSteps,
      successfulSteps,
      failedSteps,
      verified: task.verified,
    });
  }

  return Object.freeze({ task, results: Object.freeze(results) });
}
