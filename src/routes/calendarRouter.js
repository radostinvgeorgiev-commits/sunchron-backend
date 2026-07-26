import express from "express";
import {
  CalendarServiceError,
  listUpcomingEvents,
} from "../services/calendarService.js";
import {
  evaluatePermission,
  recordAuditEvent,
} from "../services/permissionService.js";

const router = express.Router();
const AUDIT_TIMEOUT_MS = 2000;

async function auditAction(event) {
  try {
    await Promise.race([
      recordAuditEvent(event),
      new Promise((resolve) => setTimeout(resolve, AUDIT_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.error("[Calendar audit] Write failure:", error);
  }
}

router.get("/status", async (req, res) => {
  const permission = evaluatePermission("calendar.read");
  if (permission.decision !== "allow") {
    return res.status(403).json({ error: permission.reason });
  }
  try {
    const events = await listUpcomingEvents({ days: 1, limit: 1 });
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: "succeeded",
      resource: "GET /calendar/status",
    });
    res.json({ status: "connected", mode: "read-only", reachable: true, events: events.length });
  } catch (error) {
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: "failed",
      resource: "GET /calendar/status",
      details: error?.code,
    });
    const status = error instanceof CalendarServiceError ? error.status : 500;
    res.status(status).json({
      error: error instanceof CalendarServiceError
        ? error.message
        : "Неочаквана грешка в календарния модул.",
      code: error?.code || "INTERNAL_ERROR",
    });
  }
});

router.get("/events", async (req, res) => {
  const permission = evaluatePermission("calendar.read");
  if (permission.decision !== "allow") {
    return res.status(403).json({ error: permission.reason });
  }
  try {
    const events = await listUpcomingEvents({
      days: req.query.days,
      limit: req.query.limit,
      timeMin: req.query.timeMin,
    });
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: "succeeded",
      resource: "GET /calendar/events",
      details: `events:${events.length}`,
    });
    res.json({ mode: "read-only", timezone: "Europe/Sofia", events });
  } catch (error) {
    const status = error instanceof CalendarServiceError ? error.status : 500;
    res.status(status).json({
      error: error instanceof CalendarServiceError
        ? error.message
        : "Неочаквана грешка в календарния модул.",
      code: error?.code || "INTERNAL_ERROR",
    });
  }
});

export default router;
