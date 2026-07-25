import express from "express";
import {
  getConfiguredRepository,
  getCommitDetails,
  getFileContent,
  getRepositorySummary,
  GitHubServiceError,
  listRecentCommits,
} from "../services/githubService.js";
import {
  evaluatePermission,
  recordAuditEvent,
} from "../services/permissionService.js";

const router = express.Router();

function requireGitHubRead(req, res, next) {
  const permission = evaluatePermission("github.read");
  if (permission.decision !== "allow") {
    return res.status(403).json({
      error: permission.reason,
      code: "PERMISSION_DENIED",
    });
  }
  req.permission = permission;
  next();
}

async function audit(req, outcome, details = null) {
  try {
    await recordAuditEvent({
      action: "github.read",
      decision: req.permission?.decision,
      outcome,
      resource: `${req.method} ${req.baseUrl}${req.path}`,
      details,
    });
  } catch (error) {
    console.error("[Audit] Write failure:", error);
  }
}

async function sendError(req, res, error) {
  await audit(req, "failed", error?.code || error?.message);
  if (error instanceof GitHubServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error("[GitHub] Unexpected failure:", error);
  return res.status(500).json({
    error: "Неочаквана грешка в GitHub модула.",
    code: "INTERNAL_ERROR",
  });
}

router.use(requireGitHubRead);

router.get("/status", async (req, res) => {
  try {
    const repository = getConfiguredRepository();
    const summary = await getRepositorySummary(repository);
    await audit(req, "succeeded", repository);
    res.json({ status: "connected", mode: "read-only", ...summary });
  } catch (error) {
    await sendError(req, res, error);
  }
});

router.get("/commits", async (req, res) => {
  try {
    const commits = await listRecentCommits(
      getConfiguredRepository(),
      req.query.limit,
    );
    await audit(req, "succeeded", `commits:${commits.length}`);
    res.json({ mode: "read-only", commits });
  } catch (error) {
    await sendError(req, res, error);
  }
});

router.get("/commit/:ref", async (req, res) => {
  try {
    const commit = await getCommitDetails(
      req.params.ref,
      getConfiguredRepository(),
    );
    await audit(req, "succeeded", `commit:${commit.shortSha}`);
    res.json({ mode: "read-only", commit });
  } catch (error) {
    await sendError(req, res, error);
  }
});

router.get("/file", async (req, res) => {
  try {
    const file = await getFileContent(
      req.query.path,
      getConfiguredRepository(),
      req.query.ref,
    );
    await audit(req, "succeeded", file.path);
    res.json({ mode: "read-only", ...file });
  } catch (error) {
    await sendError(req, res, error);
  }
});

export default router;
