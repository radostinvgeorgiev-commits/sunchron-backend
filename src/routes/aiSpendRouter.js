import express from "express";

import { getAiSpendService } from "../services/aiSpendService.js";

export function createAiSpendRouter({ service = getAiSpendService() } = {}) {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      res.json(await service.summary());
    } catch {
      res.status(503).json({
        error: "Разходът временно не може да се прочете.",
        code: "AI_SPEND_UNAVAILABLE",
      });
    }
  });

  router.put("/limit", async (req, res) => {
    try {
      res.json(await service.setLimit(req.body?.limitUsd));
    } catch (error) {
      res.status(error.status || 503).json({
        error: error.status ? error.message : "Лимитът не беше записан.",
        code: error.code || "AI_SPEND_UNAVAILABLE",
      });
    }
  });

  return router;
}

export default createAiSpendRouter;
