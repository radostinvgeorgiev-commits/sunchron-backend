import express from "express";

import { transcribeVoice, VoiceError } from "../services/voiceTranscriptionService.js";

export function createVoiceRouter({ transcribe = transcribeVoice } = {}) {
  const router = express.Router();
  router.post("/transcribe", async (req, res) => {
    try {
      const result = await transcribe(req.body || {});
      res.json({ text: result.text, provider: result.provider });
    } catch (error) {
      if (error instanceof VoiceError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      if (error?.status && error?.code) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return res.status(502).json({ error: "Записът не можа да се разпознае.", code: "VOICE_FAILED" });
    }
  });
  return router;
}

export default createVoiceRouter;
