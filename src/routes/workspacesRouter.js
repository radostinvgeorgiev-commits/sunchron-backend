import express from "express";

import {
  loadWorkspaceState,
  saveWorkspaceState,
  WorkspaceStateError,
} from "../services/workspaceStateService.js";
import { logSafeError } from "../utils/safeLogging.js";

function ownerId(req) {
  return req.owner?.memoryOwnerId || "";
}

function sendError(res, error) {
  if (error instanceof WorkspaceStateError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  logSafeError("[Workspaces] Unexpected failure", error);
  return res.status(503).json({
    error: "Работната област временно не е достъпна.",
    code: "WORKSPACE_STATE_UNAVAILABLE",
  });
}

export function createWorkspacesRouter({ load = loadWorkspaceState, save = saveWorkspaceState } = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      return res.json(await load(ownerId(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put("/", async (req, res) => {
    try {
      return res.json(await save(ownerId(req), req.body?.state));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createWorkspacesRouter();
