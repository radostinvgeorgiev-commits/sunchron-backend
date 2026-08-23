import {
  markDurableConfirmationUsed,
  validateTaskConfirmation,
} from "./confirmationService.js";

function confirmationError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * Executes the exact prepared operations grouped by one task confirmation.
 * The group is consumed before the first write, so a retry cannot duplicate
 * the task. Each underlying confirmation still validates its own owner,
 * session, resource and expiry constraints.
 */
export async function confirmTaskWrite({
  ownerId,
  sessionId,
  taskConfirmationId,
  taskId,
  githubSessionId,
  googleSessionId,
  env = process.env,
  executeCapability,
  confirmCodeTask,
  resolveGitHubSession,
} = {}) {
  if (typeof executeCapability !== "function") {
    ({ executeCapability } = await import("../tools/capabilityEngine.js"));
  }
  if (typeof confirmCodeTask !== "function") {
    ({ confirmCodeTask } = await import("./codeTaskService.js"));
  }

  const confirmation = await validateTaskConfirmation(taskConfirmationId, {
    ownerId,
    sessionId,
    taskId,
  });
  const items = Array.isArray(confirmation.resource?.items)
    ? confirmation.resource.items
    : [];
  if (!items.length) {
    throw confirmationError(
      "В потвърждението няма подготвени операции.",
      "TASK_CONFIRMATION_ITEMS_MISSING",
    );
  }

  // Consume the group before executing to make the approval one-time.
  await markDurableConfirmationUsed(taskConfirmationId);

  const results = [];
  for (const item of items) {
    try {
      if (
        item.toolId === "github-write" ||
        item.confirmationType === "code-task"
      ) {
        const result = await confirmCodeTask({
          ownerId,
          sessionId,
          githubSessionId,
          confirmationId: item.confirmationId,
          ...(resolveGitHubSession ? { resolveGitHubSession } : {}),
        });
        results.push({ capability: item.capability, result });
        continue;
      }

      const result = await executeCapability(
        item.capability,
        {
          ownerId,
          sessionId,
          githubSessionId,
          googleSessionId,
          confirmationId: item.confirmationId,
        },
        { confirmed: true, env },
      );
      results.push({ capability: item.capability, result });
    } catch (error) {
      results.push({
        capability: item.capability,
        error,
        code: error?.code || "TASK_WRITE_FAILED",
      });
    }
  }

  const failed = results.filter((item) => item.error);
  if (failed.length) {
    const error = confirmationError(
      failed.length === results.length
        ? "Нито една подготвена промяна не беше изпълнена."
        : `Изпълнението завърши частично: ${results.length - failed.length} от ${results.length} операции са успешни.`,
      failed.length === results.length
        ? "TASK_WRITE_FAILED"
        : "TASK_WRITE_PARTIAL",
      failed.length === results.length ? 502 : 207,
    );
    error.results = results;
    throw error;
  }

  return Object.freeze({
    taskId: confirmation.resource.taskId,
    results: Object.freeze(results.map((item) => Object.freeze(item))),
  });
}

export function extractTaskConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message.trim().match(
    /^Потвърждавам AI CORE задача:\s*([0-9a-f]{8}-[0-9a-f-]{27,})$/iu,
  );
  return match?.[1] || null;
}

export function formatTaskConfirmation(confirmation) {
  const count = Array.isArray(confirmation?.items)
    ? confirmation.items.length
    : 0;
  return [
    `Подготвих ${count} точни записващи операции в една задача.`,
    "Нищо не е записано още.",
    `Потвърждение: ${confirmation.confirmationId}.`,
    `Валидно до: ${new Date(confirmation.expiresAt).toISOString()}.`,
    `За изпълнение изпрати точно: Потвърждавам AI CORE задача: ${confirmation.confirmationId}`,
  ].join("\n");
}
