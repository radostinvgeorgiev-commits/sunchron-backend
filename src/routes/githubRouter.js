import express from "express";
import {
  getConfiguredRepository,
  getFileContent,
  getRepositorySummary,
  GitHubServiceError,
  listRecentCommits,
} from "../services/githubService.js";

const router = express.Router();

function sendError(res, error) {
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

router.get("/status", async (_req, res) => {
  try {
    const repository = getConfiguredRepository();
    const summary = await getRepositorySummary(repository);
    res.json({ status: "connected", mode: "read-only", ...summary });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/commits", async (req, res) => {
  try {
    const commits = await listRecentCommits(
      getConfiguredRepository(),
      req.query.limit,
    );
    res.json({ mode: "read-only", commits });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/file", async (req, res) => {
  try {
    const file = await getFileContent(
      req.query.path,
      getConfiguredRepository(),
      req.query.ref,
    );
    res.json({ mode: "read-only", ...file });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
