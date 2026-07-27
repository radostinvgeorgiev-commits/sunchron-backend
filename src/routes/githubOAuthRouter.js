import express from "express";
import {
  buildGitHubAuthorizationUrl,
  createGitHubNonce,
  createGitHubSession,
  disconnectGitHubSession,
  exchangeGitHubCode,
  getGitHubSession,
  GitHubOAuthError,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";

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

router.get("/connect", (_req, res) => {
  try {
    const state = createGitHubNonce();
    res.setHeader(
      "Set-Cookie",
      `synchron_github_state=${state}; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    res.redirect(buildGitHubAuthorizationUrl(state));
  } catch (error) {
    sendError(res, error);
  }
});

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
    res.setHeader("Set-Cookie", [
      `synchron_github_session=${session.id}; ${COOKIE_OPTIONS}`,
      "synchron_github_state=; Path=/api/github; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    res.redirect("/?github=connected");
  } catch (error) {
    console.error("[GitHub OAuth callback]", error);
    res.redirect("/?github=error");
  }
});

router.get("/status", async (req, res) => {
  try {
    const session = await getGitHubSession(sessionId(req));
    res.json({
      configured: Boolean(
        process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET &&
        process.env.GITHUB_REDIRECT_URI,
      ),
      connected: Boolean(session),
      login: session?.login || null,
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
