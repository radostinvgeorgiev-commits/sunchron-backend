import express from "express";
import {
  buildGitHubAuthorizationUrl,
  createGitHubNonce,
  createGitHubSession,
  disconnectGitHubSession,
  exchangeGitHubCode,
  getGitHubSession,
  GitHubOAuthError,
  isAuthorizedGitHubLogin,
  isGitHubOAuthConfigured,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import {
  clearGitHubSignInStateCookie,
  finishGitHubSignIn,
  isGitHubSignInCallback,
} from "../services/githubSignInService.js";
import { userSessionCookie } from "../services/userAuthService.js";
import { recordActivity } from "../services/activityService.js";
import { logSafeError } from "../utils/safeLogging.js";
import { markStartHost, returnToConnectStart } from "../middleware/returnToConnectStart.js";

const router = express.Router();
const COOKIE_OPTIONS =
  "Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000";

function sessionId(req) {
  return parseGitHubCookies(req.headers.cookie).synchron_github_session;
}

function sendError(res, error) {
  const status = error instanceof GitHubOAuthError ? error.status : 500;
  res.status(status).json({
    error:
      error instanceof GitHubOAuthError
        ? error.message
        : "GitHub временно не е достъпен.",
    code: error?.code || "GITHUB_OAUTH_ERROR",
  });
}

router.get("/connect", (req, res) => {
  try {
    // The state says on which of the site's names the connect started, so a
    // return to the other name finishes here (returnToConnectStart.js).
    const state = markStartHost(createGitHubNonce(), req.get("host"));
    res.setHeader(
      "Set-Cookie",
      `synchron_github_state=${state}; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    res.redirect(buildGitHubAuthorizationUrl(state));
  } catch (error) {
    sendError(res, error);
  }
});

export function createGitHubCallbackHandler({
  finishSignIn = finishGitHubSignIn,
  logError = logSafeError,
} = {}) {
  return async function githubSignInCallback(req, res, next) {
    if (
      !isGitHubSignInCallback({
        state: req.query.state,
        cookieHeader: req.headers.cookie,
      })
    ) {
      return next();
    }
    try {
      const result = await finishSignIn({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        cookieHeader: req.headers.cookie,
      });
      if (result.created) recordActivity({ registrations: 1 });
      res.setHeader("Set-Cookie", [
        userSessionCookie(result.session),
        clearGitHubSignInStateCookie(),
      ]);
      return res.redirect(302, "/");
    } catch (error) {
      logError("[GitHub sign-in] callback", error);
      res.setHeader("Set-Cookie", clearGitHubSignInStateCookie());
      return res.redirect(
        302,
        `/?auth_error=${encodeURIComponent(error.code || "AUTH_GITHUB_FAILED")}`,
      );
    }
  };
}

// A person's "Вход с GitHub" comes back here too; it is handled first.
router.get("/callback", createGitHubCallbackHandler());
// A connect pressed on the site's other name finishes there.
router.get(
  "/callback",
  returnToConnectStart({ path: "/api/github/callback", cookie: "synchron_github_state" }),
);

router.get("/callback", async (req, res) => {
  try {
    const cookies = parseGitHubCookies(req.headers.cookie);
    if (
      !req.query.code ||
      !req.query.state ||
      req.query.state !== cookies.synchron_github_state
    ) {
      throw new GitHubOAuthError(
        "Невалидно или изтекло GitHub потвърждение.",
        400,
        "INVALID_GITHUB_OAUTH_STATE",
      );
    }
    const tokens = await exchangeGitHubCode(String(req.query.code));
    const session = await createGitHubSession(tokens);
    if (!isAuthorizedGitHubLogin(session.login)) {
      await disconnectGitHubSession(session.id);
      throw new GitHubOAuthError(
        "Този GitHub профил няма достъп до личната система.",
        403,
        "OWNER_GITHUB_LOGIN_REQUIRED",
      );
    }
    res.setHeader("Set-Cookie", [
      `synchron_github_session=${session.id}; ${COOKIE_OPTIONS}`,
      "synchron_github_state=; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    res.redirect("/?github=connected");
  } catch (error) {
    logSafeError("[GitHub OAuth callback]", error);
    res.redirect("/?github=error");
  }
});

router.get("/status", async (req, res) => {
  try {
    const session = await getGitHubSession(sessionId(req));
    const authorized = Boolean(
      session && isAuthorizedGitHubLogin(session.login),
    );
    res.json({
      configured: isGitHubOAuthConfigured(),
      connected: authorized,
      authorized,
      login: authorized ? session.login : null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    await disconnectGitHubSession(sessionId(req));
    res.setHeader(
      "Set-Cookie",
      "synchron_github_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    res.json({ connected: false });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
