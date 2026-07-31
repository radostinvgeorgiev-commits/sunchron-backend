import express from "express";
import {
  createConfirmation,
  denyConfirmation,
  listAllowedActions,
  markConfirmationUsed,
  validateConfirmation,
} from "../services/confirmationService.js";
import {
  getConfiguredRepository,
  GitHubServiceError,
} from "../services/githubService.js";
import {
  createBranch,
  createFile,
  createPullRequest,
  updateFile,
} from "../services/githubWriteService.js";
import {
  CopilotTaskError,
  startCopilotTask,
} from "../services/copilotTaskService.js";
import {
  GitHubOAuthError,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import {
  executeAuditedWriteAction,
  isAuditSafetyError,
  recordAuditEvent,
} from "../services/permissionService.js";
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";

const router = express.Router();

async function auditAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    logSafeError("[Confirmed action audit] Write failure", error);
  }
}

function resourceLabel(resource) {
  if (!resource || typeof resource !== "object") return null;
  return Object.entries(resource)
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
}

// ─── GET /confirmed-actions ───────────────────────────────────────────────────
// Lists allowed write actions (read-only discovery endpoint).
router.get("/", (_req, res) => {
  res.json({ allowedActions: listAllowedActions() });
});

// ─── POST /confirmed-actions/request ─────────────────────────────────────────
// Step 1: Request a confirmation token for a write action.
// Returns a confirmationId the user must explicitly submit back.
router.post("/request", async (req, res) => {
  const { sessionId, action, resource, params } = req.body || {};
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";

  if (!cleanSessionId) {
    return res
      .status(400)
      .json({ error: "Липсва валидна сесия.", code: "MISSING_SESSION" });
  }

  let confirmation;
  try {
    confirmation = createConfirmation({
      sessionId: cleanSessionId,
      action,
      resource,
      params,
    });
  } catch (error) {
    await auditAction({
      action: typeof action === "string" ? action : "unknown",
      decision: "deny",
      outcome: "blocked",
      resource: resourceLabel(resource),
      details: safeErrorCode(error, "CONFIRMATION_REQUEST_BLOCKED"),
      sessionId: cleanSessionId,
    });
    const status = error.code === "UNKNOWN_ACTION" ? 400 : 422;
    return res.status(status).json({ error: error.message, code: error.code });
  }

  await auditAction({
    action: confirmation.action,
    decision: "confirm",
    outcome: "requested",
    resource: resourceLabel(confirmation.resource),
    details: "confirmation_requested",
    sessionId: cleanSessionId,
  });

  return res.status(201).json({
    confirmationId: confirmation.id,
    action: confirmation.action,
    resource: confirmation.resource,
    expiresAt: new Date(confirmation.expiresAt).toISOString(),
    message: buildPrompt(confirmation),
  });
});

// ─── POST /confirmed-actions/confirm ─────────────────────────────────────────
// Step 2: User explicitly confirms a specific pending action.
// A general "yes" without a confirmationId is impossible — by design.
router.post("/confirm", async (req, res) => {
  const { confirmationId, sessionId } = req.body || {};
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const cleanId =
    typeof confirmationId === "string" ? confirmationId.trim() : "";

  if (!cleanSessionId) {
    return res
      .status(400)
      .json({ error: "Липсва валидна сесия.", code: "MISSING_SESSION" });
  }
  if (!cleanId) {
    return res.status(400).json({
      error: "Липсва идентификатор на потвърждение.",
      code: "MISSING_CONFIRMATION_ID",
    });
  }

  let confirmation;
  try {
    confirmation = validateConfirmation(cleanId, cleanSessionId);
  } catch (error) {
    const outcomeMap = {
      CONFIRMATION_EXPIRED: "expired",
      CONFIRMATION_NOT_FOUND: "not_found",
      SESSION_MISMATCH: "session_mismatch",
    };
    await auditAction({
      action: "github.write",
      decision: "confirm",
      outcome: outcomeMap[error.code] || "denied",
      details: safeErrorCode(error, "CONFIRMATION_DENIED"),
      sessionId: cleanSessionId,
    });
    const statusMap = {
      CONFIRMATION_NOT_FOUND: 404,
      CONFIRMATION_EXPIRED: 410,
      SESSION_MISMATCH: 403,
    };
    return res
      .status(statusMap[error.code] || 400)
      .json({ error: error.message, code: error.code });
  }

  // Mark used before execution to prevent any chance of double-execution
  markConfirmationUsed(cleanId);

  let result;
  try {
    const githubSessionId =
      parseGitHubCookies(req.headers.cookie).synchron_github_session || "";
    result = await executeAuditedWriteAction({
      action: "github.write",
      capability: confirmation.action,
      actor: cleanSessionId,
      sessionId: cleanSessionId,
      confirmationId: cleanId,
      resource: resourceLabel(confirmation.resource),
      details: "confirmed_action",
      execute: () => executeAction(confirmation, githubSessionId),
    });
  } catch (error) {
    if (!isAuditSafetyError(error)) {
      await auditAction({
        action: confirmation.action,
        decision: "confirmed",
        outcome: "failed",
        resource: resourceLabel(confirmation.resource),
        details: safeErrorCode(error, "EXECUTION_ERROR"),
        sessionId: cleanSessionId,
      });
    }
    const status =
      isAuditSafetyError(error) ||
      error instanceof GitHubServiceError ||
      error instanceof GitHubOAuthError ||
      error instanceof CopilotTaskError
        ? error.status
        : 500;
    return res
      .status(status)
      .json({ error: error.message, code: error.code || "EXECUTION_ERROR" });
  }

  return res.json({ status: "ok", action: confirmation.action, result });
});

// ─── POST /confirmed-actions/deny ─────────────────────────────────────────────
// User explicitly denies / cancels a pending confirmation.
router.post("/deny", async (req, res) => {
  const { confirmationId, sessionId } = req.body || {};
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const cleanId =
    typeof confirmationId === "string" ? confirmationId.trim() : "";

  if (!cleanSessionId || !cleanId) {
    return res.status(400).json({
      error: "Липсват задължителни полета (sessionId, confirmationId).",
      code: "MISSING_FIELDS",
    });
  }

  let confirmation;
  try {
    confirmation = denyConfirmation(cleanId, cleanSessionId);
  } catch (error) {
    const status = error.code === "CONFIRMATION_NOT_FOUND" ? 404 : 403;
    return res.status(status).json({ error: error.message, code: error.code });
  }

  await auditAction({
    action: confirmation.action,
    decision: "denied",
    outcome: "denied",
    resource: resourceLabel(confirmation.resource),
    details: "confirmation_denied",
    sessionId: cleanSessionId,
  });

  return res.json({ status: "ok", message: "Действието беше отказано." });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPrompt(confirmation) {
  const parts = Object.entries(confirmation.resource)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return (
    `Потвърди действие "${confirmation.action}" върху [${parts}]. ` +
    `Изпрати POST /confirmed-actions/confirm с confirmationId: "${confirmation.id}". ` +
    `Валидно до: ${new Date(confirmation.expiresAt).toISOString()}.`
  );
}

async function executeAction(confirmation, githubSessionId = "") {
  const { action, resource, params } = confirmation;
  const defaultRepo = getConfiguredRepository();

  switch (action) {
    case "github.write:create_file":
      return createFile({
        repository: resource.repository || defaultRepo,
        branch: resource.branch,
        path: resource.path,
        content: params.content ?? "",
        message: params.message || `Create ${resource.path}`,
      });

    case "github.write:update_file":
      return updateFile({
        repository: resource.repository || defaultRepo,
        branch: resource.branch,
        path: resource.path,
        content: params.content ?? "",
        message: params.message || `Update ${resource.path}`,
        sha: resource.sha,
      });

    case "github.write:create_branch":
      return createBranch({
        repository: resource.repository || defaultRepo,
        branchName: resource.branchName,
        fromBranch: resource.fromBranch || "main",
      });

    case "github.write:create_pr":
      return createPullRequest({
        repository: resource.repository || defaultRepo,
        title: params.title,
        body: params.body || "",
        head: resource.head,
        base: resource.base || "main",
      });

    case "github.copilot:start_task":
      return startCopilotTask({
        githubSessionId,
        prompt: params.prompt,
        repository: resource.repository || defaultRepo,
        baseRef: resource.baseRef || "main",
      });

    default: {
      throw new GitHubServiceError(
        `Непознато действие: "${action}".`,
        400,
        "UNKNOWN_ACTION",
      );
    }
  }
}

export default router;
