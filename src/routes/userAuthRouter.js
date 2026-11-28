import express from "express";
import {
  requestPasswordReset,
  clearUserSessionCookie,
  getUserAuthConfigurationStatus,
  getUserAuthProvider,
  isPublicRegistration,
  isUserAuthConfigured,
  signInUser,
  signOutUser,
  userSessionCookie,
  UserAuthError,
} from "../services/userAuthService.js";
import {
  disconnectGitHubSession,
  getGitHubSession,
  isAuthorizedGitHubLogin,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import { linkPrimaryOwnerAccount } from "../services/testerAccessService.js";
import { resolveRequestIdentity } from "../middleware/ownerAuth.js";
import {
  clearGoogleSignInStateCookie,
  finishGoogleSignIn,
  isGoogleSignInEnabled,
  isMovedSignInState,
  startGoogleSignIn,
} from "../services/googleSignInService.js";
import {
  isGitHubSignInEnabled,
  startGitHubSignIn,
} from "../services/githubSignInService.js";
import {
  clearProviderSignInCookie,
  finishProviderSignIn,
  providerSignInStatus,
  SIGN_IN_PROVIDERS,
  startProviderSignIn,
} from "../services/providerSignInService.js";
import { logSafeError } from "../utils/safeLogging.js";
import { recordActivity } from "../services/activityService.js";

const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
});

function sendAuthError(res, error) {
  const known = error instanceof UserAuthError;
  return res.status(known ? error.status : 500).json({
    error: known
      ? error.message
      : "Входът временно не е достъпен. Опитай отново.",
    code: known ? error.code : "AUTH_UNEXPECTED_ERROR",
  });
}

router.get("/session", async (req, res) => {
  try {
    const identity = await resolveRequestIdentity(req, res);
    return res.json({
      configured: isUserAuthConfigured(),
      configuration: getUserAuthConfigurationStatus(),
      // New profiles are made only by signing in with an outside account
      // (Google today). Existing email/password profiles can still sign in.
      registrationEnabled:
        isUserAuthConfigured() &&
        (isGoogleSignInEnabled() ||
          isGitHubSignInEnabled() ||
          Object.values(providerSignInStatus()).some(Boolean)),
      registrationMode: isPublicRegistration() ? "public" : "invite",
      passwordRegistration: false,
      googleSignIn: isGoogleSignInEnabled(),
      githubSignIn: isGitHubSignInEnabled(),
      providerSignIn: providerSignInStatus(),
      authProvider: getUserAuthProvider(),
      authenticated: Boolean(identity),
      user: identity
        ? {
            id: identity.id,
            email: identity.email || null,
            displayName: identity.displayName,
            role: identity.role,
            authProvider: identity.authProvider,
          }
        : null,
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
});

router.post("/login", async (req, res) => {
  try {
    const result = await signInUser(req.body || {});
    res.setHeader("Set-Cookie", userSessionCookie(result.session));
    return res.json({
      authenticated: true,
      user: {
        id: result.user.id,
        email: result.user.email,
      },
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
});

// Registration with an email and a password is closed: a new profile is made
// by the first sign-in with Google (or another outside account). Profiles that
// already have a password keep working through /login and /password-reset.
router.post("/register", (_req, res) => {
  return res.status(410).json({
    error:
      "Нов профил с имейл и парола вече не се прави. Натисни „Продължи с Google“ — профилът се създава сам при първия вход.",
    code: "AUTH_PASSWORD_SIGNUP_REMOVED",
  });
});

router.get("/google/start", (req, res) => {
  try {
    // moved=1: the start came from the site's other name, where nobody was
    // signed in (src/middleware/startOnCallbackOrigin.js).
    const { url, cookie } = startGoogleSignIn({ moved: req.query.moved === "1" });
    res.setHeader("Set-Cookie", cookie);
    return res.redirect(302, url);
  } catch (error) {
    logSafeError("[Google sign-in] start", error);
    return res.redirect(302, `/?auth_error=${encodeURIComponent(error.code || "AUTH_GOOGLE_FAILED")}`);
  }
});

// "Вход с GitHub" for every person. The callback is the GitHub app's
// registered /api/github/callback (githubOAuthRouter), told apart from the
// owner's connection by its own state cookie.
router.get("/github/start", (_req, res) => {
  try {
    const { url, cookie } = startGitHubSignIn();
    res.setHeader("Set-Cookie", cookie);
    return res.redirect(302, url);
  } catch (error) {
    logSafeError("[GitHub sign-in] start", error);
    return res.redirect(302, `/?auth_error=${encodeURIComponent(error.code || "AUTH_GITHUB_FAILED")}`);
  }
});

// "Вход с Facebook" / "Вход с Microsoft" through Identity Platform's own
// redirect flow (providerSignInService).
export function createProviderSignInHandlers(
  name,
  {
    start = startProviderSignIn,
    finish = finishProviderSignIn,
    logError = logSafeError,
  } = {},
) {
  const failed = (res, error) =>
    res.redirect(
      302,
      `/?auth_error=${encodeURIComponent(error?.code || `AUTH_${name.toUpperCase()}_FAILED`)}`,
    );
  return {
    async start(_req, res) {
      try {
        const { url, cookie } = await start(name);
        res.setHeader("Set-Cookie", cookie);
        return res.redirect(302, url);
      } catch (error) {
        logError(`[${name} sign-in] start`, error);
        return failed(res, error);
      }
    },
    async callback(req, res) {
      try {
        const result = await finish(name, {
          query: req.query,
          cookieHeader: req.headers.cookie,
          originalUrl: req.originalUrl,
        });
        if (result.created) recordActivity({ registrations: 1 });
        res.setHeader("Set-Cookie", [
          userSessionCookie(result.session),
          clearProviderSignInCookie(name),
        ]);
        return res.redirect(302, "/");
      } catch (error) {
        logError(`[${name} sign-in] callback`, error);
        res.setHeader("Set-Cookie", clearProviderSignInCookie(name));
        return failed(res, error);
      }
    },
  };
}

for (const name of Object.keys(SIGN_IN_PROVIDERS)) {
  const handlers = createProviderSignInHandlers(name);
  router.get(`/${name}/start`, handlers.start);
  router.get(`/${name}/callback`, handlers.callback);
}

// "Вход с Google" finished in a browser that already holds the verified owner
// GitHub session links that Google account to the owner: from then on a
// Google sign-in alone opens the owner's memory and tools. The sign-in itself
// is protected by the one-time state cookie, so nobody can push their own
// Google account into the owner's browser. A sign-in moved here from the
// site's other name never links: it was started on a page where nobody was
// signed in, so the owner session on this name says nothing about who picked
// the Google account.
async function ownerGitHubSessionPresent(cookieHeader, getSession) {
  const cookies = parseGitHubCookies(cookieHeader);
  if (!cookies.synchron_github_session) return false;
  const session = await getSession(cookies.synchron_github_session);
  return Boolean(session && isAuthorizedGitHubLogin(session.login));
}

export function createGoogleSignInCallbackHandler({
  finish = finishGoogleSignIn,
  getSession = getGitHubSession,
  linkOwner = linkPrimaryOwnerAccount,
  logError = logSafeError,
} = {}) {
  return async function googleSignInCallback(req, res) {
    try {
      const result = await finish({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        cookieHeader: req.headers.cookie,
      });
      if (result.created) recordActivity({ registrations: 1 });
      let ownerLinked = false;
      try {
        if (
          !isMovedSignInState(req.query.state) &&
          (await ownerGitHubSessionPresent(req.headers.cookie, getSession))
        ) {
          await linkOwner(result.user);
          ownerLinked = true;
        }
      } catch (linkError) {
        logError("[Google sign-in] owner link", linkError);
      }
      if (ownerLinked) {
        // Keep the owner GitHub session; the new Google session is not needed
        // in this browser, and the owner should land as the owner.
        res.setHeader("Set-Cookie", clearGoogleSignInStateCookie());
        return res.redirect(302, "/?owner_google_linked=1");
      }
      res.setHeader("Set-Cookie", [
        userSessionCookie(result.session),
        clearGoogleSignInStateCookie(),
      ]);
      return res.redirect(302, "/");
    } catch (error) {
      logError("[Google sign-in] callback", error);
      res.setHeader("Set-Cookie", clearGoogleSignInStateCookie());
      return res.redirect(
        302,
        `/?auth_error=${encodeURIComponent(error.code || "AUTH_GOOGLE_FAILED")}`,
      );
    }
  };
}

export const handleGoogleSignInCallback = createGoogleSignInCallbackHandler();
router.get("/google/callback", handleGoogleSignInCallback);

router.post("/password-reset", async (req, res) => {
  try {
    await requestPasswordReset({ email: req.body?.email });
    return res.status(202).json({ sent: true });
  } catch (error) {
    return sendAuthError(res, error);
  }
});

router.post("/logout", async (req, res) => {
  try {
    await signOutUser(req.headers.cookie);
    const githubCookies = parseGitHubCookies(req.headers.cookie);
    await disconnectGitHubSession(githubCookies.synchron_github_session);
  } catch (error) {
    logSafeError("[User logout]", error);
  }
  res.setHeader("Set-Cookie", [
    clearUserSessionCookie(),
    "synchron_github_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);
  return res.json({ authenticated: false });
});

export default router;
