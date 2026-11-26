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
  sessionBelongsTo,
} from "../services/googleDriveService.js";
import { logSafeError } from "../utils/safeLogging.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { ProductError } from "../services/productPlansService.js";

const router = express.Router();
const COOKIE_OPTIONS =
  "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000";

function cookieSessionId(req) {
  return parseCookies(req.headers.cookie).synchron_google_session;
}

// The browser cookie only counts when the connection belongs to this account,
// so two people on one browser never see each other's Google data.
async function sessionId(req) {
  const id = cookieSessionId(req);
  return (await sessionBelongsTo(id, req.owner)) ? id : null;
}

function ownerOnly(req, res, next) {
  if (req.owner?.role === "owner") return next();
  return res.status(403).json({
    error: "Това е достъпно само за собственика.",
    code: "OWNER_ONLY",
  });
}

function sendError(res, error) {
  const known = error instanceof GoogleDriveError || error instanceof ProductError;
  const status = known ? error.status : 500;
  res.status(status).json({
    error:
      known
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
    const id = await createSession(tokens, req.owner);
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

router.get("/restore", ownerOnly, async (_req, res) => {
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
  const id = await sessionId(req);
  res.json({
    connected: Boolean(id) && (await hasSession(id)),
    canRestore: req.owner?.role === "owner",
  });
});

router.post("/disconnect", async (req, res) => {
  const id = await sessionId(req);
  if (id) await disconnectSession(id);
  res.setHeader(
    "Set-Cookie",
    "synchron_google_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  );
  res.json({ connected: false });
});

router.get("/files", async (req, res) => {
  try {
    res.json({ files: await listDriveFiles(await sessionId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/gmail/messages", async (req, res) => {
  try {
    res.json({
      messages: await listGmailMessages(await sessionId(req), req.query.limit),
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
        await sessionId(req),
        req.query.days,
        req.query.limit,
      ),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/analyze", publicAiBudgetContext, async (req, res) => {
  try {
    const { fileId, prompt } = req.body || {};
    const file = await downloadDriveFile(await sessionId(req), String(fileId || ""));
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
