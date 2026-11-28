import express from "express";

import { ToolSwitchError } from "../services/toolSwitchService.js";
import { logSafeError } from "../utils/safeLogging.js";

// „Разкачи“ and „Свържи“ on the cards in „Инструменти“: each person's own
// switches, for the tools their account can use (toolSwitchService.js).
export function createToolSwitchRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const fail = (res, error, fallback) => {
    if (error instanceof ToolSwitchError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logSafeError("[Tools] switches", error);
    return res.status(503).json({ error: fallback, code: "TOOL_SWITCH_UNAVAILABLE" });
  };

  router.get("/", async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await service.list(owner(req), req.owner));
    } catch (error) {
      fail(res, error, "Инструментите не могат да се заредят.");
    }
  });
  router.put("/:toolId", async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await service.set(owner(req), req.owner, req.params.toolId, req.body?.on));
    } catch (error) {
      fail(res, error, "Промяната не беше записана. Опитай пак.");
    }
  });
  return router;
}
