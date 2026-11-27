import express from "express";

import { ProductError } from "../services/productPlansService.js";
import { publicAiBudgetContext, reservePublicAiClaudeWork } from "../services/publicAiBudget.js";
import { AddonError } from "../services/addonService.js";
import { ClaudeWorkError, skillInstructions } from "../services/claudeWorkService.js";
import { logSafeError } from "../utils/safeLogging.js";

// "Работа с Claude": every account can hand a bigger task to Claude and get
// text and finished files back. Members pay units per task; the owner not.
// The person's own skills and connectors come from "Добавки" (`addons`).
export function createClaudeWorkRouter({ service, addons, reserve = reservePublicAiClaudeWork }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const fail = (res, error, fallback) => {
    if (error instanceof ClaudeWorkError || error instanceof ProductError || error instanceof AddonError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logSafeError("[Claude work]", error);
    return res.status(503).json({ error: fallback, code: "CLAUDE_WORK_FAILED" });
  };
  router.get("/", async (req, res) => {
    try {
      res.json({
        skills: service.skills(),
        addons: addons ? await addons.claudeChoices(owner(req)) : [],
        files: await service.listFiles(owner(req)),
      });
    } catch (error) {
      fail(res, error, "Работата с Claude не може да се зареди.");
    }
  });
  router.post("/", publicAiBudgetContext, async (req, res) => {
    let refund = async () => false;
    try {
      const body = req.body || {};
      const picked = addons ? await addons.forClaude(owner(req), body.addons) : { skills: [], connectors: [] };
      refund = await reserve("claude-work", "");
      res.json(
        await service.run(owner(req), {
          task: body.task,
          skills: body.skills,
          webSearch: body.webSearch,
          instructions: skillInstructions(picked.skills),
          connectors: picked.connectors,
        }),
      );
    } catch (error) {
      await refund().catch(() => false);
      fail(res, error, "Claude не успя със задачата. Опитай пак.");
    }
  });
  router.get("/files/:id", async (req, res) => {
    try {
      const file = await service.download(owner(req), req.params.id);
      const ascii = file.name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
      res.set({
        "Content-Type": file.mimeType,
        "Content-Length": String(file.body.length),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(file.body);
    } catch (error) {
      fail(res, error, "Файлът не може да се изтегли.");
    }
  });
  return router;
}
