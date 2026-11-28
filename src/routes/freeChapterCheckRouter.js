import express from "express";

import { BookMemoryError } from "../services/bookMemoryService.js";
import { logSafeError } from "../utils/safeLogging.js";

// POST /api/free-check: the start page's chapter check, without sign-in.
export function createFreeChapterCheckRouter({ service }) {
  const router = express.Router();
  router.post("/", async (req, res) => {
    try {
      res.json({ result: await service.check(req.body || {}) });
    } catch (error) {
      if (error instanceof BookMemoryError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logSafeError("[FreeCheck]", error);
      return res.status(503).json({ error: "Проверката не можа да стане. Опитай пак след малко.", code: "FREE_CHECK_UNAVAILABLE" });
    }
  });
  return router;
}
