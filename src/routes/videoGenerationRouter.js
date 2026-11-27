import express from "express";

import { ProductError } from "../services/productPlansService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { VideoGenerationError } from "../services/videoGenerationService.js";
import { logSafeError } from "../utils/safeLogging.js";

// The finished clip goes back as the MP4 file itself, not as text, so the
// page can play and save it without a big base64 copy.
// Owner's decision 2026-11-27: the owner tries videos first; members get
// them (for 100 units each) once he has seen the result.
export const VIDEOS_FOR_MEMBERS = false;

export function createVideoGenerationRouter({ service, forMembers = VIDEOS_FOR_MEMBERS }) {
  const router = express.Router();
  router.post("/", publicAiBudgetContext, async (req, res) => {
    if (!forMembers && req.owner?.role !== "owner") {
      return res.status(403).json({ error: "Видеата скоро ще са достъпни за всички.", code: "VIDEO_NOT_YET_OPEN" });
    }
    try {
      const result = await service.generate(req.body?.prompt, { aspectRatio: req.body?.aspectRatio });
      res.set({
        "Content-Type": result.mimeType,
        "Content-Length": String(result.video.length),
        "Cache-Control": "no-store",
        "X-Video-Aspect-Ratio": result.aspectRatio,
      });
      return res.send(result.video);
    } catch (error) {
      if (error instanceof VideoGenerationError || error instanceof ProductError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logSafeError("[Video generation]", error);
      return res.status(503).json({ error: "Видеото не стана. Опитай пак.", code: "VIDEO_GENERATION_FAILED" });
    }
  });
  return router;
}
