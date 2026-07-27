import express from "express";
import {
  GoogleDriveError,
  hasSession,
  listGoogleCalendarEvents,
  parseCookies,
} from "../services/googleDriveService.js";
import {
  evaluatePermission,
  recordAuditEvent,
} from "../services/permissionService.js";

const router = express.Router();
const AUDIT_TIMEOUT_MS = 2000;

function sessionId(req) {
  return parseCookies(req.headers.cookie).synchron_google_session;
}

async function auditAction(event) {
  try {
    await Promise.race([
      recordAuditEvent(event),
      new Promise((resolve) => setTimeout(resolve, AUDIT_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.error(
      "[Calendar audit] Write failure:",
      error?.message || "unknown",
    );
  }
}

function sendError(res, error) {
  const status = error instanceof GoogleDriveError ? error.status : 500;
  res.status(status).json({
    error:
      error instanceof GoogleDriveError
        ? error.message
        : "Неочаквана грешка в календарния модул.",
    code: error?.code || "INTERNAL_ERROR",
  });
}

router.get("/status", async (req, res) => {
  const permission = evaluatePermission("calendar.read");
  if (permission.decision !== "allow") {
    return res.status(403).json({ error: permission.reason });
  }

  try {
    const connected = await hasSession(sessionId(req));
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: connected ? "succeeded" : "not-connected",
      resource: "GET /calendar/status",
    });
    res.json({
      status: connected ? "connected" : "not-connected",
      mode: "read-only",
      reachable: connected,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/events", async (req, res) => {
  const permission = evaluatePermission("calendar.read");
  if (permission.decision !== "allow") {
    return res.status(403).json({ error: permission.reason });
  }

  try {
    const events = await listGoogleCalendarEvents(
      sessionId(req),
      req.query.days,
      req.query.limit,
    );
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: "succeeded",
      resource: "GET /calendar/events",
      details: `events:${events.length}`,
    });
    res.json({ mode: "read-only", timezone: "Europe/Sofia", events });
  } catch (error) {
    await auditAction({
      action: "calendar.read",
      decision: permission.decision,
      outcome: "failed",
      resource: "GET /calendar/events",
      details: error?.code,
    });
    sendError(res, error);
  }
});

export default router;
