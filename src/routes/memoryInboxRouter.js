import express from "express";
import {
  approveMemorySuggestion,
  dismissMemorySuggestion,
  listMemorySuggestions,
  MemorySuggestionError,
} from "../services/memorySuggestionService.js";
import { logSafeError } from "../utils/safeLogging.js";

function ownerOf(req) {
  return typeof req.owner?.memoryOwnerId === "string"
    ? req.owner.memoryOwnerId
    : "";
}

function sendError(res, error) {
  const status = Number(error?.status) || 503;
  if (error instanceof MemorySuggestionError || error?.code) {
    return res.status(status >= 400 && status < 600 ? status : 503).json({
      error: error.message || "Входящите временно не са достъпни.",
      code: error.code || "MEMORY_SUGGESTIONS_UNAVAILABLE",
    });
  }
  logSafeError("[Memory inbox] Failure", error);
  return res.status(503).json({
    error: "Входящите временно не са достъпни.",
    code: "MEMORY_SUGGESTIONS_UNAVAILABLE",
  });
}

export function createMemoryInboxRouter({
  list = listMemorySuggestions,
  approve = approveMemorySuggestion,
  dismiss = dismissMemorySuggestion,
} = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    try {
      return res.json({ items: await list(ownerOf(req)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:id/approve", async (req, res) => {
    try {
      const fact =
        typeof req.body?.fact === "string" ? req.body.fact : undefined;
      return res.json(
        await approve({ ownerId: ownerOf(req), id: req.params.id, fact }),
      );
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/:id/dismiss", async (req, res) => {
    try {
      return res.json(
        await dismiss({ ownerId: ownerOf(req), id: req.params.id }),
      );
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createMemoryInboxRouter();
