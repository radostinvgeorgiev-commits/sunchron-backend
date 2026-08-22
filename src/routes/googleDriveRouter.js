import express from "express";
import {
  GoogleDriveError,
  analyzeDriveFile,
  buildAuthorizationUrl,
  createNonce,
  createSession,
  disconnectSession,
  downloadDriveFile,
  exchangeCode,
  getLatestGoogleSessionId,
  hasSession,
  listGmailMessages,
  listGoogleCalendarEvents,
  listDriveFiles,
  parseCookies,
} from "../services/googleDriveService.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();
const COOKIE_OPTIONS =
  "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000";

function sessionId(req) {
  return parseCookies(req.headers.cookie).synchron_google_session;
}

function sendError(res, error) {
  const status = error instanceof GoogleDriveError ? error.status : 500;
  res.status(status).json({
    error:
      error instanceof GoogleDriveError
        ? error.message
        : "Google Drive временно не е достъпен.",
  });
}

router.get("/connect", (req, res) => {
  try {
    const state = createNonce();
    res.setHeader(
      "Set-Cookie",
      `synchron_google_state=${state}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    res.redirect(buildAuthorizationUrl(state));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/callback", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (
      !req.query.code ||
      !req.query.state ||
      req.query.state !== cookies.synchron_google_state
    ) {
      throw new GoogleDriveError(
        "Невалидно или изтекло Google потвърждение.",
        400,
        "INVALID_OAUTH_STATE",
      );
    }
    const tokens = await exchangeCode(String(req.query.code));
    const id = await createSession(tokens);
    res.setHeader("Set-Cookie", [
      `synchron_google_session=${id}; ${COOKIE_OPTIONS}`,
      "synchron_google_state=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    res.redirect("/?google=connected");
  } catch (error) {
    logSafeError("[Google OAuth callback]", error);
    res.redirect("/?google=error");
  }
});

router.get("/restore", async (_req, res) => {
  try {
    const id = await getLatestGoogleSessionId();
    if (!id) {
      return res.status(404).json({
        error: "Няма възстановима Google сесия.",
        code: "GOOGLE_SESSION_NOT_FOUND",
      });
    }
    res.setHeader(
      "Set-Cookie",
      `synchron_google_session=${id}; ${COOKIE_OPTIONS}`,
    );
    return res.redirect("/?google=connected");
  } catch (error) {
    logSafeError("[Google OAuth restore]", error);
    return res.status(503).json({
      error: "Google връзката не можа да бъде възстановена.",
      code: "GOOGLE_SESSION_RESTORE_FAILED",
    });
  }
});

router.get("/status", async (req, res) => {
  res.json({ connected: await hasSession(sessionId(req)) });
});

router.post("/disconnect", async (req, res) => {
  await disconnectSession(sessionId(req));
  res.setHeader(
    "Set-Cookie",
    "synchron_google_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  );
  res.json({ connected: false });
});

router.get("/files", async (req, res) => {
  try {
    res.json({ files: await listDriveFiles(sessionId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/gmail/messages", async (req, res) => {
  try {
    res.json({
      messages: await listGmailMessages(sessionId(req), req.query.limit),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/calendar/events", async (req, res) => {
  try {
    res.json({
      timezone: "Europe/Sofia",
      events: await listGoogleCalendarEvents(
        sessionId(req),
        req.query.days,
        req.query.limit,
      ),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/analyze", async (req, res) => {
  try {
    const { fileId, prompt } = req.body || {};
    const file = await downloadDriveFile(sessionId(req), String(fileId || ""));
    const analysis = await analyzeDriveFile({
      ...file,
      prompt: typeof prompt === "string" ? prompt.trim() : "",
    });
    res.json({ analysis, fileName: file.name });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;

