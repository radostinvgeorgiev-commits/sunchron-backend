import express from "express";

import { parseCookies } from "../services/googleDriveService.js";
import { ProductError } from "../services/productPlansService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";

export function createDailyPlanRouter({ service }) {
  const router = express.Router();
  // One AI request; members pay it from their credits.
  router.post("/", publicAiBudgetContext, async (req, res) => {
    try {
      const result = await service.plan(req.owner, {
        googleSessionId: parseCookies(req.headers.cookie).synchron_google_session || "",
        note: typeof req.body?.note === "string" ? req.body.note : "",
        period: req.body?.period === "week" ? "week" : "day",
      });
      if (!result.text) throw new Error("empty plan");
      res.json(result);
    } catch (error) {
      if (error instanceof ProductError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logSafeError("[Daily plan]", error);
      return res.status(503).json({ error: "Планът не можа да се подготви. Опитай пак.", code: "DAILY_PLAN_FAILED" });
    }
  });
  return router;
}
