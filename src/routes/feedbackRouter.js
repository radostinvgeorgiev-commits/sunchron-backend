import express from "express";

import { FeedbackError } from "../services/feedbackService.js";

export function createFeedbackRouter({ service }) {
  const router = express.Router();
  router.post("/", async (req, res) => {
    try {
      await service.record(req.body?.votes || req.body);
      res.status(201).json({ saved: true });
    } catch (error) {
      if (error instanceof FeedbackError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return res.status(503).json({ error: "Оценката не беше записана.", code: "FEEDBACK_UNAVAILABLE" });
    }
  });
  router.get("/summary", async (req, res) => {
    if (req.owner?.role !== "owner") {
      return res.status(403).json({ error: "Само за собственика.", code: "FORBIDDEN" });
    }
    try {
      return res.json(await service.summary());
    } catch {
      return res.status(503).json({ error: "Оценките не могат да се прочетат.", code: "FEEDBACK_UNAVAILABLE" });
    }
  });
  return router;
}
