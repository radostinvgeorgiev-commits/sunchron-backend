import express from "express";
import { validateDurableConfirmation } from "../services/confirmationService.js";
import { confirmGitHubChange } from "../services/githubActionService.js";
import { getLatestAuthorizedGitHubSession } from "../services/githubOAuthService.js";
import { logSafeError } from "../utils/safeLogging.js";

const allowedActions = new Set([
  "github.write:create_branch",
  "github.write:create_file",
  "github.write:update_file",
  "github.write:create_pr",
]);

export function createClaudeConfirmationRouter({
  validate = validateDurableConfirmation,
  confirmGitHub = confirmGitHubChange,
  getGitHubSession = getLatestAuthorizedGitHubSession,
} = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      req.get("origin") !== "https://cloudaicore.com" ||
      !req.is("application/json")
    ) {
      return res.status(403).json({ error: "Невалиден произход на заявката." });
    }
    return next();
  });
  async function find(req) {
    const id =
      typeof req.body?.confirmationId === "string"
        ? req.body.confirmationId.trim()
        : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        id,
      )
    ) {
      throw Object.assign(new Error("Невалиден идентификатор."), {
        status: 400,
      });
    }
    const sessionId = `claude:${req.owner.memoryOwnerId}`;
    const confirmation = await validate(id, sessionId);
    if (!allowedActions.has(confirmation.action)) {
      throw Object.assign(new Error("Тази операция не е разрешена."), {
        status: 403,
      });
    }
    return { id, sessionId, confirmation };
  }
  function failure(res, error) {
    logSafeError("[Claude confirmation]", error);
    return res
      .status(error?.status >= 400 && error.status < 600 ? error.status : 400)
      .json({
        error:
          "Потвърждението е невалидно, изтекло или не може да бъде изпълнено.",
      });
  }
  router.post("/inspect", async (req, res) => {
    try {
      const { confirmation } = await find(req);
      const { ownerFingerprint, githubLoginFingerprint, ...resource } =
        confirmation.resource || {};
      return res.json({
        action: confirmation.action,
        resource,
        params: confirmation.params,
        expiresAt: confirmation.expiresAt,
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post("/confirm", async (req, res) => {
    try {
      const { id, sessionId, confirmation } = await find(req);
      const options = {
        ownerId: req.owner.memoryOwnerId,
        sessionId,
        confirmationId: id,
      };
      await confirmGitHub({
        ...options,
        githubSession: await getGitHubSession(),
      });
      return res.json({ ok: true });
    } catch (error) {
      return failure(res, error);
    }
  });
  return router;
}
