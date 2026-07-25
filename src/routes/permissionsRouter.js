import express from "express";
import {
  evaluatePermission,
  listAuditEvents,
  listPermissions,
} from "../services/permissionService.js";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    defaultDecision: "deny",
    permissions: listPermissions(),
  });
});

router.get("/check", (req, res) => {
  res.json(evaluatePermission(req.query.action));
});

router.get("/audit", async (req, res) => {
  try {
    const events = await listAuditEvents(req.query.limit);
    res.json({ events });
  } catch (error) {
    console.error("[Audit] Read failure:", error);
    res.status(503).json({
      error: "Дневникът на действията временно не е достъпен.",
      code: "AUDIT_UNAVAILABLE",
    });
  }
});

export default router;
