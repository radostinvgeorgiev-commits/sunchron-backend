import express from "express";
import {
  requestPasswordReset,
  clearUserSessionCookie,
  getUserAuthConfigurationStatus,
  getUserAuthProvider,
  isUserRegistrationEnabled,
  isPublicRegistration,
  isUserAuthConfigured,
  registerUser,
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
  startGoogleSignIn,
} from "../services/googleSignInService.js";
import { logSafeError } from "../utils/safeLogging.js";
import {
  logCampaignEvent,
  readCampaignAttribution,
} from "../services/campaignAttribution.js";

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
      registrationEnabled: isUserRegistrationEnabled(),
      registrationMode: isPublicRegistration() ? "public" : "invite",
      googleSignIn: isGoogleSignInEnabled(),
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

router.post("/register", async (req, res) => {
  try {
    const { campaign, ...registration } = req.body || {};
    const result = await registerUser(registration);
    if (result.created) {
      logCampaignEvent(
        "campaign_registration",
        readCampaignAttribution(campaign),
      );
    }
    if (result.session) {
      res.setHeader("Set-Cookie", userSessionCookie(result.session));
    }
    return res.status(201).json({
      authenticated: Boolean(result.session),
      confirmationRequired: result.confirmationRequired,
      user: {
        id: result.user.id,
        email: result.user.email,
      },
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
});

router.get("/google/start", (_req, res) => {
  try {
    const { url, cookie } = startGoogleSignIn();
    res.setHeader("Set-Cookie", cookie);
    return res.redirect(302, url);
  } catch (error) {
    logSafeError("[Google sign-in] start", error);
    return res.redirect(302, `/?auth_error=${encodeURIComponent(error.code || "AUTH_GOOGLE_FAILED")}`);
  }
});

// "Вход с Google" finished in a browser that already holds the verified owner
// GitHub session links that Google account to the owner: from then on a
// Google sign-in alone opens the owner's memory and tools. The sign-in itself
// is protected by the one-time state cookie, so nobody can push their own
// Google account into the owner's browser.
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
      let ownerLinked = false;
      try {
        if (await ownerGitHubSessionPresent(req.headers.cookie, getSession)) {
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
