import express from "express";

import { analyzeImage } from "../services/imageService.js";
import { KNOWLEDGE_LIMITS, KnowledgeFilesError } from "../services/knowledgeFilesService.js";

export function createKnowledgeFilesRouter({ service, readDocument = analyzeImage }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const fail = (res, error, fallback) =>
    error instanceof KnowledgeFilesError || (error?.status && error?.code)
      ? res.status(error.status).json({ error: error.message, code: error.code })
      : res.status(503).json({ error: fallback, code: "KNOWLEDGE_UNAVAILABLE" });

  router.get("/", async (req, res) => {
    try {
      res.json({ files: await service.list(owner(req)), limits: KNOWLEDGE_LIMITS });
    } catch (error) {
      fail(res, error, "Файловете не могат да се заредят.");
    }
  });

  // Text files arrive as text; a PDF arrives as a data URL and Claude reads
  // its text first (one file-priced AI call for members).
  router.post("/", async (req, res) => {
    try {
      let text = typeof req.body?.text === "string" ? req.body.text : "";
      if (!text && req.body?.pdf) {
        text = await readDocument({
          image: { dataUrl: req.body.pdf, mimeType: "application/pdf", name: req.body?.name },
          prompt:
            "Извлечи целия текст на документа дословно, по реда на страниците. Върни само текста, без коментари и без обобщение.",
        });
      }
      res.status(201).json({ file: await service.add(owner(req), { name: req.body?.name, text }) });
    } catch (error) {
      fail(res, error, "Файлът не беше добавен.");
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      res.json(await service.remove(owner(req), req.params.id));
    } catch (error) {
      fail(res, error, "Файлът не беше изтрит.");
    }
  });
  return router;
}
