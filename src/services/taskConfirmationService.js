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
  language,
  // A member may confirm only steps on their own Google; the whole task is
  // refused, before anything runs, when one step is not allowed.
  allowItem,
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

  if (typeof allowItem === "function" && !items.every((item) => allowItem(item))) {
    throw confirmationError(
      "Тази задача съдържа действие, достъпно само за собственика.",
      "OWNER_ONLY",
      403,
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
          ...(language ? { language } : {}),
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

// The owner confirms a prepared task by sending this exact command, in
// Bulgarian or in English.
export function extractTaskConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^(?:Потвърждавам (?:Novarium|AI CORE) задача|Confirm (?:Novarium|AI CORE) task):\s*([0-9a-f]{8}-[0-9a-f-]{27,})$/iu,
    );
  return match?.[1] || null;
}

// `summaries` say what each prepared step will do ("Send an email to …"),
// so the person knows exactly what they confirm. Blank lines and "- " keep
// each part on its own line in the chat.
export function formatTaskConfirmation(confirmation, english = false, summaries = []) {
  const count = Array.isArray(confirmation?.items)
    ? confirmation.items.length
    : 0;
  const steps = (Array.isArray(summaries) ? summaries : [])
    .filter((summary) => typeof summary === "string" && summary.trim())
    .map((summary) => `- ${summary.trim()}`);
  const expires = new Date(confirmation.expiresAt).toISOString();
  if (english) {
    return [
      steps.length
        ? "Ready, but nothing has been done yet:"
        : `Prepared ${count} write operations. Nothing has been done yet.`,
      ...(steps.length ? [steps.join("\n")] : []),
      `Confirmation: ${confirmation.confirmationId}. Expires: ${expires}.`,
      `To proceed, press Confirm or send this exact command: Confirm Novarium task: ${confirmation.confirmationId}`,
    ].join("\n\n");
  }
  return [
    steps.length
      ? "Подготвих, но още нищо не е направено:"
      : `Подготвих ${count} точни записващи операции в една задача. Нищо не е записано още.`,
    ...(steps.length ? [steps.join("\n")] : []),
    `Потвърждение: ${confirmation.confirmationId}. Валидно до: ${expires}.`,
    `За изпълнение натисни „Потвърди“ или изпрати точно: Потвърждавам Novarium задача: ${confirmation.confirmationId}`,
  ].join("\n\n");
}

// The reply after a confirmed task: what each step did.
export function formatConfirmedTask(confirmed, english = false) {
  const results = Array.isArray(confirmed?.results) ? confirmed.results : [];
  const done = results
    .map((item) => item?.result?.output)
    .filter((output) => typeof output === "string" && output.trim())
    .map((output) => `- ${output.trim()}`);
  return [
    english
      ? `Done: the confirmed Novarium task ran ${results.length} operation${results.length === 1 ? "" : "s"}.`
      : `Потвърдената Novarium задача е изпълнена: ${results.length} операции.`,
    ...(done.length ? [done.join("\n")] : []),
  ].join("\n\n");
}
