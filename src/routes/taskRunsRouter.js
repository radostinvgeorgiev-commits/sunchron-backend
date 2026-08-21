import express from "express";

import {
  cancelTaskRun,
  createTaskRun,
  getTaskRun,
  listTaskRuns,
  pauseTaskRun,
  recordTaskRunCheckpoint,
  resumeTaskRun,
  TaskRunError,
} from "../services/taskRunService.js";
import { logSafeError } from "../utils/safeLogging.js";

function ownerId(req) {
  return req.owner?.memoryOwnerId || "";
}

function sendError(res, error) {
  if (error instanceof TaskRunError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  logSafeError("[Task runs] Unexpected failure", error);
  return res.status(503).json({
    error: "Устойчивото изпълнение временно не е достъпно.",
    code: "TASK_RUNS_UNAVAILABLE",
  });
}

export function createTaskRunsRouter({
  list = listTaskRuns,
  get = getTaskRun,
  create = createTaskRun,
  checkpoint = recordTaskRunCheckpoint,
  pause = pauseTaskRun,
  resume = resumeTaskRun,
  cancel = cancelTaskRun,
} = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const items = await list({
        ownerId: ownerId(req),
        status: req.query.status,
        limit: req.query.limit,
      });
      return res.json({ items });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const item = await create({
        ownerId: ownerId(req),
        sessionId: req.body?.sessionId,
        title: req.body?.title,
        mode: req.body?.mode,
        steps: req.body?.steps,
      });
      return res.status(201).json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/:runId", async (req, res) => {
    try {
      const item = await get({ ownerId: ownerId(req), runId: req.params.runId });
      return res.json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:runId/checkpoints", async (req, res) => {
    try {
      const item = await checkpoint({
        ownerId: ownerId(req),
        runId: req.params.runId,
        status: req.body?.status,
        stepIndex: req.body?.stepIndex,
        message: req.body?.message,
        source: req.body?.source,
        waitingConfirmation: req.body?.waitingConfirmation,
      });
      return res.json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:runId/pause", async (req, res) => {
    try {
      const item = await pause({
        ownerId: ownerId(req),
        runId: req.params.runId,
        reason: req.body?.reason,
      });
      return res.json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:runId/resume", async (req, res) => {
    try {
      const item = await resume({
        ownerId: ownerId(req),
        runId: req.params.runId,
      });
      return res.json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:runId/cancel", async (req, res) => {
    try {
      const item = await cancel({
        ownerId: ownerId(req),
        runId: req.params.runId,
      });
      return res.json({ item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createTaskRunsRouter();
