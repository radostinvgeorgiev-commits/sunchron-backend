import express from "express";
import {
  GoogleDriveError,
  analyzePdf,
  buildAuthorizationUrl,
  createNonce,
  createSession,
  disconnectSession,
  downloadPdf,
  exchangeCode,
  hasSession,
  listPdfFiles,
  parseCookies,
} from "../services/googleDriveService.js";

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
  try {
    res.json({ files: await listPdfFiles(sessionId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/analyze", async (req, res) => {
  try {
    const { fileId, prompt } = req.body || {};
    const pdf = await downloadPdf(sessionId(req), String(fileId || ""));
    const analysis = await analyzePdf({
      ...pdf,
      prompt: typeof prompt === "string" ? prompt.trim() : "",
    });
    res.json({ analysis, fileName: pdf.name });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
