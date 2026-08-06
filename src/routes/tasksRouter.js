import express from "express";

import {
  addTaskNote,
  confirmTaskStatusChange,
  createTaskDraft,
  linkTaskToProject,
  listTasks,
  prepareTaskStatusChange,
  TaskManagementError,
} from "../services/taskManagementService.js";
import { logSafeError } from "../utils/safeLogging.js";

function ownerId(req) {
  return req.owner?.memoryOwnerId || "";
}

function sendError(res, error) {
  if (error instanceof TaskManagementError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
    });
  }
  logSafeError("[Tasks] Unexpected failure", error);
  return res.status(503).json({
    error: "Задачите временно не са достъпни.",
    code: "TASKS_UNAVAILABLE",
  });
}

export function createTasksRouter({
  list = listTasks,
  createDraft = createTaskDraft,
  addNote = addTaskNote,
  linkProject = linkTaskToProject,
  prepareStatus = prepareTaskStatusChange,
  confirmStatus = confirmTaskStatusChange,
} = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const items = await list({
        ownerId: ownerId(req),
        unfinished: req.query.unfinished === "true",
        status: req.query.status,
        projectId: req.query.projectId,
        limit: req.query.limit,
      });
      return res.json({ items });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const task = await createDraft({
        ownerId: ownerId(req),
        title: req.body?.title,
        projectId: req.body?.projectId,
        note: req.body?.note,
      });
      return res.status(201).json({ task });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:taskId/notes", async (req, res) => {
    try {
      const task = await addNote({
        ownerId: ownerId(req),
        taskId: req.params.taskId,
        note: req.body?.note,
      });
      return res.json({ task });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:taskId/project", async (req, res) => {
    try {
      const task = await linkProject({
        ownerId: ownerId(req),
        taskId: req.params.taskId,
        projectId: req.body?.projectId,
      });
      return res.json({ task });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:taskId/status/prepare", async (req, res) => {
    try {
      const prepared = await prepareStatus({
        ownerId: ownerId(req),
        sessionId: req.body?.sessionId,
        taskId: req.params.taskId,
        status: req.body?.status,
      });
      return res.status(409).json({
        error: "Промяната на статус изисква точно потвърждение.",
        code: "TASK_STATUS_CONFIRMATION_REQUIRED",
        ...prepared,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/status/confirm", async (req, res) => {
    try {
      const task = await confirmStatus({
        ownerId: ownerId(req),
        sessionId: req.body?.sessionId,
        confirmationId: req.body?.confirmationId,
      });
      return res.json({ task });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createTasksRouter();
