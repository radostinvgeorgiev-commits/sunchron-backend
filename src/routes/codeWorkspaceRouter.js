import { createHash } from "node:crypto";
import express from "express";
import {
  CodeTaskError,
  confirmCodeTask,
  prepareCodeTask,
} from "../services/codeTaskService.js";
import {
  getCodeWorkspaceChecks,
  getConfiguredRepository,
  getRepositorySummary,
  GitHubServiceError,
} from "../services/githubService.js";
import {
  getGitHubSession,
  isAuthorizedGitHubLogin,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import { isAuditSafetyError } from "../services/permissionService.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();

router.use(async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const githubSessionId = parseGitHubCookies(
    req.headers.cookie,
  ).synchron_github_session;
  const githubSession = await getGitHubSession(githubSessionId);
  if (
    !githubSession?.accessToken ||
    !isAuthorizedGitHubLogin(githubSession.login)
  ) {
    return res.status(401).json({
      error: "Свържи разрешения GitHub профил, за да използваш работния екран.",
      code: "GITHUB_SESSION_REQUIRED",
    });
  }
  req.codeWorkspace = {
    ownerId: req.owner.memoryOwnerId,
    githubSessionId,
    githubSession,
    sessionId: createHash("sha256")
      .update(`code-workspace:\0${githubSessionId}`)
      .digest("hex"),
  };
  next();
});

router.get("/repository", async (req, res) => {
  const repository = getConfiguredRepository();
  await getRepositorySummary(repository, {
    accessToken: req.codeWorkspace.githubSession.accessToken,
  });
  res.json({ repository, base: "main" });
});

router.post("/prepare", async (req, res) => {
  const { repository, message } = req.body || {};
  if (repository !== getConfiguredRepository()) {
    return res.status(400).json({
      error: "Избери разрешено хранилище.",
      code: "REPOSITORY_NOT_ALLOWED",
    });
  }
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 8_000
  ) {
    return res.status(400).json({
      error: "Опиши задачата с до 8000 знака.",
      code: "CODE_TASK_INVALID_MESSAGE",
    });
  }
  const draft = await prepareCodeTask({
    ...req.codeWorkspace,
    message,
    reviewRepository: repository,
  });
  const {
    confirmationId,
    expiresAt,
    baseSha,
    title,
    summary,
    review,
    council,
    unavailableProviders,
    executor,
    advice,
  } = draft;
  res.json({
    confirmationId,
    expiresAt,
    repository,
    baseSha,
    title,
    summary,
    review,
    council,
    unavailableProviders,
    executor,
    advice,
  });
});

router.post("/confirm", async (req, res) => {
  const { confirmationId } = req.body || {};
  if (
    typeof confirmationId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(confirmationId)
  ) {
    return res.status(400).json({
      error: "Липсва валиден преглед за потвърждение.",
      code: "CODE_TASK_CONFIRMATION_REQUIRED",
    });
  }
  res.json(await confirmCodeTask({ ...req.codeWorkspace, confirmationId }));
});

router.get("/checks/:sha", async (req, res) => {
  const checks = await getCodeWorkspaceChecks(
    req.params.sha,
    getConfiguredRepository(),
    {
      accessToken: req.codeWorkspace.githubSession.accessToken,
    },
  );
  res.json({ checks });
});

router.use((error, _req, res, _next) => {
  if (isAuditSafetyError(error) && error.result) {
    return res.json({ ...error.result, auditWarning: error.message });
  }
  if (
    error instanceof GitHubServiceError ||
    error instanceof CodeTaskError ||
    isAuditSafetyError(error)
  ) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  if (
    [
      "CONFIRMATION_NOT_FOUND",
      "CONFIRMATION_EXPIRED",
      "SESSION_MISMATCH",
    ].includes(error?.code)
  ) {
    return res.status(409).json({
      error: "Потвърждението вече не е достъпно. Подготви нов преглед.",
      code: error.code,
    });
  }
  logSafeError("[Code workspace]", error);
  res.status(503).json({
    error: "Работният екран временно не успя да завърши заявката.",
    code: "CODE_WORKSPACE_UNAVAILABLE",
  });
});

export default router;
