import express from "express";

import { ImageGenerationError } from "../services/imageGenerationService.js";
import { ProductError } from "../services/productPlansService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";

export function createImageGenerationRouter({ service }) {
  const router = express.Router();
  router.post("/", publicAiBudgetContext, async (req, res) => {
    try {
      res.json(await service.generate(req.body?.prompt));
    } catch (error) {
      if (error instanceof ImageGenerationError || error instanceof ProductError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logSafeError("[Image generation]", error);
      return res.status(503).json({ error: "Картинката не стана. Опитай пак.", code: "IMAGE_GENERATION_FAILED" });
    }
  });
  return router;
}
