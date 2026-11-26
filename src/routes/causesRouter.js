import express from "express";

import { CAUSE_LIMITS, CausesError } from "../services/causesService.js";

export function createCausesRouter({ service }) {
  const router = express.Router();
  const run = (work) => async (req, res) => {
    try {
      res.json({ causes: await work(req), limits: CAUSE_LIMITS, moderator: req.owner?.role === "owner" });
    } catch (error) {
      if (error instanceof CausesError) {
        res.status(error.status).json({ error: error.message, code: error.code });
      } else {
        res.status(503).json({ error: "Каузите не са достъпни в момента.", code: "CAUSES_UNAVAILABLE" });
      }
    }
  };
  router.get("/", run((req) => service.list(req.owner)));
  router.post("/", run((req) => service.propose(req.owner, req.body || {})));
  router.post("/:id/like", run((req) => service.like(req.owner, req.params.id, req.body?.on !== false)));
  router.delete("/:id", run((req) => service.remove(req.owner, req.params.id)));
  return router;
}
