import express from "express";
import { auditIntegrationEvent } from "../services/auditService.js";
import {
  GoogleDriveError,
  analyzeDriveFile,
  buildAuthorizationUrl,
  createNonce,
  createSession,
  disconnectSession,
  downloadDriveFile,
  exchangeCode,
  hasSession,
  listGmailMessages,
  listGoogleCalendarEvents,
  listDriveFiles,
  parseCookies,
} from "../services/googleDriveService.js";
import { evaluatePermission } from "../services/permissionService.js";

const router = express.Router();
const COOKIE_OPTIONS = "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000";

function sessionId(req) {
  return parseCookies(req.headers.cookie).synchron_google_session;
}

function sendError(res, error) {
  const status = error instanceof GoogleDriveError ? error.status : 500;
  res.status(status).json({
    error: error instanceof GoogleDriveError ? error.message : "Google Drive временно не е достъпен.",
  });
}

async function requirePermission(res, action, resource) {
  const permission = evaluatePermission(action);
  if (permission.decision === "allow") return permission;

  await auditIntegrationEvent(
    {
      action,
      decision: permission.decision,
      outcome: "blocked",
      resource,
      details: permission.reason,
    },
    "Google routes audit",
  );
  res.status(403).json({ error: permission.reason });
  return null;
}

router.get("/connect", (req, res) => {
  try {
    const state = createNonce();
    res.setHeader("Set-Cookie", `synchron_google_state=${state}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.redirect(buildAuthorizationUrl(state));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/callback", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (!req.query.code || !req.query.state || req.query.state !== cookies.synchron_google_state) {
      throw new GoogleDriveError("Невалидно или изтекло Google потвърждение.", 400, "INVALID_OAUTH_STATE");
    }
    const tokens = await exchangeCode(String(req.query.code));
    const id = createSession(tokens);
    res.setHeader("Set-Cookie", [
      `synchron_google_session=${id}; ${COOKIE_OPTIONS}`,
      "synchron_google_state=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    res.redirect("/?google=connected");
  } catch (error) {
    console.error("[Google OAuth callback]", error);
    res.redirect("/?google=error");
  }
});

router.get("/status", (req, res) => {
  res.json({ connected: hasSession(sessionId(req)) });
});

router.post("/disconnect", (req, res) => {
  disconnectSession(sessionId(req));
  res.setHeader("Set-Cookie", "synchron_google_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ connected: false });
});

router.get("/files", async (req, res) => {
  const permission = await requirePermission(res, "drive.read", "GET /api/google/files");
  if (!permission) return;
  try {
    const files = await listDriveFiles(sessionId(req));
    await auditIntegrationEvent(
      {
        action: "drive.read",
        decision: permission.decision,
        outcome: "succeeded",
        resource: "GET /api/google/files",
        details: `files:${files.length}`,
      },
      "Google routes audit",
    );
    res.json({ files });
  } catch (error) {
    await auditIntegrationEvent(
      {
        action: "drive.read",
        decision: permission.decision,
        outcome: "failed",
        resource: "GET /api/google/files",
        details: error?.code || "GOOGLE_DRIVE_ERROR",
      },
      "Google routes audit",
    );
    sendError(res, error);
  }
});

router.get("/gmail/messages", async (req, res) => {
  const permission = await requirePermission(
    res,
    "mail.read",
    "GET /api/google/gmail/messages",
  );
  if (!permission) return;
  try {
    const messages = await listGmailMessages(sessionId(req), req.query.limit);
    await auditIntegrationEvent(
      {
        action: "mail.read",
        decision: permission.decision,
        outcome: "succeeded",
        resource: "GET /api/google/gmail/messages",
        details: `messages:${messages.length}`,
      },
      "Google routes audit",
    );
    res.json({ messages });
  } catch (error) {
    await auditIntegrationEvent(
      {
        action: "mail.read",
        decision: permission.decision,
        outcome: "failed",
        resource: "GET /api/google/gmail/messages",
        details: error?.code || "GMAIL_ERROR",
      },
      "Google routes audit",
    );
    sendError(res, error);
  }
});

router.get("/calendar/events", async (req, res) => {
  const permission = await requirePermission(
    res,
    "calendar.read",
    "GET /api/google/calendar/events",
  );
  if (!permission) return;
  try {
    const events = await listGoogleCalendarEvents(
      sessionId(req),
      req.query.days,
      req.query.limit,
    );
    await auditIntegrationEvent(
      {
        action: "calendar.read",
        decision: permission.decision,
        outcome: "succeeded",
        resource: "GET /api/google/calendar/events",
        details: `events:${events.length}`,
      },
      "Google routes audit",
    );
    res.json({
      timezone: "Europe/Sofia",
      events,
    });
  } catch (error) {
    await auditIntegrationEvent(
      {
        action: "calendar.read",
        decision: permission.decision,
        outcome: "failed",
        resource: "GET /api/google/calendar/events",
        details: error?.code || "GOOGLE_CALENDAR_ERROR",
      },
      "Google routes audit",
    );
    sendError(res, error);
  }
});

router.post("/analyze", async (req, res) => {
  const permission = await requirePermission(res, "drive.read", "POST /api/google/analyze");
  if (!permission) return;
  try {
    const { fileId, prompt } = req.body || {};
    const file = await downloadDriveFile(sessionId(req), String(fileId || ""));
    const analysis = await analyzeDriveFile({
      ...file,
      prompt: typeof prompt === "string" ? prompt.trim() : "",
    });
    await auditIntegrationEvent(
      {
        action: "drive.read",
        decision: permission.decision,
        outcome: "succeeded",
        resource: "POST /api/google/analyze",
        details: file.name,
      },
      "Google routes audit",
    );
    res.json({ analysis, fileName: file.name });
  } catch (error) {
    await auditIntegrationEvent(
      {
        action: "drive.read",
        decision: permission.decision,
        outcome: "failed",
        resource: "POST /api/google/analyze",
        details: error?.code || "GOOGLE_ANALYZE_ERROR",
      },
      "Google routes audit",
    );
    sendError(res, error);
  }
});

export default router;
