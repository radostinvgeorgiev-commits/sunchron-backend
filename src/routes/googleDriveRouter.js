import express from "express";
import {
  GoogleDriveError,
  analyzeDriveFile,
  buildAuthorizationUrl,
  createNonce,
  disconnectGoogleAccount,
  downloadDriveFile,
  exchangeCode,
  finishGoogleConnection,
  forgetLinkedSession,
  getLatestGoogleSessionId,
  hasSession,
  listGmailMessages,
  listGoogleCalendarEvents,
  listDriveFiles,
  searchGoogleContacts,
  parseCookies,
  getYoutubeChannelSummary,
  googleConnectPath,
  googleLoginHint,
  grantedExtras,
  isGoogleScopeMissing,
  latestMainSessionFor,
  GOOGLE_LINKED_EXTRAS,
  saveAnswerToGoogle,
  saveSessionFor,
  sessionBelongsTo,
  publishSessionFor,
  uploadVideoToYoutube,
} from "../services/googleDriveService.js";
import { logSafeError } from "../utils/safeLogging.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { ProductError } from "../services/productPlansService.js";
import { getReplyDraftService } from "../services/replyDraftService.js";

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

// This browser's connection, or else the account's newest one (a new
// browser, or the cookie expired), so a connect keeps what the person has.
async function accountSessionId(req) {
  return (await sessionId(req)) || (await latestMainSessionFor(req.owner));
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
    // Lets the page offer "Разреши" only when a permission is really missing.
    ...(known && error.code ? { code: error.code } : {}),
  });
}

router.get("/connect", async (req, res) => {
  try {
    const add = typeof req.query.add === "string" ? req.query.add : "";
    // Saving files (save) and uploading videos (publish) each get their own
    // token, linked from the main connection.
    const linked = GOOGLE_LINKED_EXTRAS.includes(add) ? add : "";
    // The step travels in the state, which Google sends back unchanged and
    // the callback checks against this browser's cookie.
    const state = `${linked ? `${linked}.` : ""}${createNonce()}`;
    // Everyone, the owner too, starts with the scopes Google's free check
    // covers. A renewed connection, or one more service (add=youtube / gmail /
    // drive), asks again for every service this connection already has.
    const current = await accountSessionId(req);
    const keep = current && !linked ? await grantedExtras(current) : [];
    const loginHint = current ? await googleLoginHint(current) : "";
    res.setHeader(
      "Set-Cookie",
      `synchron_google_state=${state}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    // The page's language (set by locale.js), so Google's screens match it.
    const language = parseCookies(req.headers.cookie).ai_core_language || "";
    res.redirect(
      buildAuthorizationUrl(state, linked ? [linked] : [...keep, add], {
        loginHint,
        language,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/callback", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!req.query.code || !state || state !== cookies.synchron_google_state) {
      throw new GoogleDriveError(
        "Невалидно или изтекло Google потвърждение.",
        400,
        "INVALID_OAUTH_STATE",
      );
    }
    const tokens = await exchangeCode(String(req.query.code));
    const { id, partial } = await finishGoogleConnection(tokens, req.owner, {
      previousId: await accountSessionId(req),
      linked: GOOGLE_LINKED_EXTRAS.find((kind) => state.startsWith(`${kind}.`)) || null,
    });
    res.setHeader("Set-Cookie", [
      `synchron_google_session=${id}; ${COOKIE_OPTIONS}`,
      "synchron_google_state=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "synchron_google_add=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    res.redirect(partial ? "/?google=partial" : "/?google=connected");
  } catch (error) {
    logSafeError("[Google OAuth callback]", error);
    res.redirect(
      error?.code === "GOOGLE_ACCOUNT_MISMATCH" ? "/?google=error&reason=account" : "/?google=error",
    );
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

// A real, read-only call to each Google service, so "Работи" in the tools
// list means it answered just now, not only that a token is stored. Nothing
// from the person's data is returned, only whether each service answered.
const GOOGLE_CHECKS = {
  drive: (id) => listDriveFiles(id),
  gmail: (id) => listGmailMessages(id, 1),
  calendar: (id) => listGoogleCalendarEvents(id, 1, 1),
  contacts: (id) => searchGoogleContacts(id, "a", 1, undefined, { fresh: false }),
  youtube: (id) => getYoutubeChannelSummary(id, 1),
};
// A service the person has not turned on yet is not "broken": the tools
// list offers its own connect button instead of "Не отговаря".
const CHECK_CONNECT = {
  youtube: googleConnectPath("youtube"),
  gmail: googleConnectPath("gmail"),
  drive: googleConnectPath("drive"),
};
// The stored Google sign-in no longer works: one "Свържи отново" fixes every
// Google tool at once, so it is not shown as broken.
const RECONNECT_CODES = new Set([
  "NOT_CONNECTED",
  "TOKEN_EXPIRED",
  "REFRESH_FAILED",
  "GOOGLE_RECONNECT_REQUIRED",
]);
const CHECK_TIMEOUT_MS = 12_000;

export async function checkGoogleServices(id, checks = GOOGLE_CHECKS) {
  const results = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, run]) => {
      let timer;
      try {
        await Promise.race([
          run(id),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new GoogleDriveError("Не отговори навреме.", 504, "TIMEOUT")), CHECK_TIMEOUT_MS);
          }),
        ]);
        results[name] = { ok: true };
      } catch (error) {
        const known = error instanceof GoogleDriveError;
        const needsConnect = known && error.code === "GOOGLE_SCOPE_REQUIRED" && CHECK_CONNECT[name];
        const needsReconnect = known && RECONNECT_CODES.has(error.code);
        if (!needsConnect) {
          console.warn(
            `[Google check] ${name} failed: ${known ? error.code : "UNEXPECTED"}${known && error.status ? ` ${error.status}` : ""}`,
          );
        }
        results[name] = needsConnect
          ? { ok: false, connect: CHECK_CONNECT[name], reason: "Още не е разрешен." }
          : needsReconnect
            ? { ok: false, connect: "/api/google/connect", reconnect: true, reason: "Връзката с Google изтече." }
            : {
              ok: false,
              reason: known ? error.message : "Не отговори.",
              ...(known && error.status ? { status: error.status } : {}),
            };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return results;
}

router.get("/check", async (req, res) => {
  const id = await sessionId(req);
  if (!id || !(await hasSession(id))) {
    return res.json({ connected: false, checkedAt: new Date().toISOString(), services: {} });
  }
  res.json({
    connected: true,
    checkedAt: new Date().toISOString(),
    services: await checkGoogleServices(id),
  });
});

router.post("/disconnect", async (req, res) => {
  try {
    await disconnectGoogleAccount(await sessionId(req), req.owner);
  } catch (error) {
    // The page says so and keeps its "Прекъсни връзката" button.
    logSafeError("[Google disconnect]", error);
    return res.status(503).json({
      error: "Връзката с Google не се прекъсна. Опитай отново.",
      code: "GOOGLE_DISCONNECT_FAILED",
    });
  }
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

// The avatar writes a reply in the person's style and saves it as a Gmail
// draft. Nothing is sent. Members pay it as one AI request.
router.post("/gmail/reply-draft", publicAiBudgetContext, async (req, res) => {
  try {
    res.json(
      await getReplyDraftService().draft(req.owner, {
        googleSessionId: cookieSessionId(req),
        messageId: String(req.body?.messageId || ""),
        note: typeof req.body?.note === "string" ? req.body.note : "",
      }),
    );
  } catch (error) {
    if (!(error instanceof GoogleDriveError) && !(error instanceof ProductError)) {
      logSafeError("[Gmail reply draft]", error);
    }
    sendError(res, error);
  }
});

// Saves one answer as a Google Doc or Sheet in the person's own Drive.
router.post("/save", async (req, res) => {
  let mainId = null;
  let saveId = null;
  try {
    const { kind, title, text } = req.body || {};
    mainId = await sessionId(req);
    saveId = await saveSessionFor(mainId);
    res.json(
      await saveAnswerToGoogle(saveId, {
        kind: kind === "sheet" ? "sheet" : "doc",
        title: typeof title === "string" ? title : "",
        text: typeof text === "string" ? text : "",
      }),
    );
  } catch (error) {
    // The linked save token itself stopped working: forget it and ask for a
    // new one, instead of offering a reconnect that would keep it.
    const deadSaveToken =
      saveId && mainId && saveId !== mainId &&
      error instanceof GoogleDriveError && RECONNECT_CODES.has(error.code);
    if (deadSaveToken) await forgetLinkedSession(mainId, saveId, "save");
    if (deadSaveToken || isGoogleScopeMissing(error)) {
      // Saving needs its own small permission (only files AI CORE creates).
      return res.status(403).json({
        error: "Запазването в Google още не е разрешено.",
        code: "GOOGLE_SCOPE_REQUIRED",
        connect: googleConnectPath("save"),
      });
    }
    sendError(res, error);
  }
});

// "Качи в YouTube" under a video made on the page: the MP4 goes to the
// person's own channel with its own small permission (youtube.upload).
// YouTube keeps it private until Google's audit of AI CORE; the answer says
// what YouTube actually set.
router.post("/youtube", express.raw({ type: "video/mp4", limit: "64mb" }), async (req, res) => {
  let mainId = null;
  let publishId = null;
  try {
    mainId = await sessionId(req);
    if (!mainId) {
      return res.status(401).json({ error: "Google не е свързан.", code: "GOOGLE_NOT_CONNECTED", connect: googleConnectPath() });
    }
    publishId = await publishSessionFor(mainId);
    if (!publishId) {
      return res.status(403).json({
        error: "Качването в YouTube още не е разрешено.",
        code: "GOOGLE_SCOPE_REQUIRED",
        connect: googleConnectPath("publish"),
      });
    }
    const title = typeof req.query.title === "string" ? req.query.title : "";
    res.json(await uploadVideoToYoutube(publishId, { bytes: req.body, title, privacy: "public" }));
  } catch (error) {
    const deadToken = publishId && error instanceof GoogleDriveError && RECONNECT_CODES.has(error.code);
    if (deadToken) await forgetLinkedSession(mainId, publishId, "publish");
    if (deadToken || isGoogleScopeMissing(error)) {
      return res.status(403).json({
        error: "Качването в YouTube още не е разрешено.",
        code: "GOOGLE_SCOPE_REQUIRED",
        connect: googleConnectPath("publish"),
      });
    }
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
