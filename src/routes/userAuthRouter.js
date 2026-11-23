import express from "express";
import {
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
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import { resolveRequestIdentity } from "../middleware/ownerAuth.js";
import { logSafeError } from "../utils/safeLogging.js";
import { authRequestContext, logAuthStep } from "../utils/authLogging.js";
import {
  logCampaignEvent,
  readCampaignAttribution,
} from "../services/campaignAttribution.js";

const router = express.Router();
router.use(authRequestContext);

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
    logAuthStep("session", identity ? "authenticated" : "anonymous");
    return res.json({
      configured: isUserAuthConfigured(),
      configuration: getUserAuthConfigurationStatus(),
      registrationEnabled: isUserRegistrationEnabled(),
      registrationMode: isPublicRegistration() ? "public" : "invite",
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
    logAuthStep("session", "failure", error);
    return sendAuthError(res, error);
  }
});

router.post("/login", async (req, res) => {
  try {
    const result = await signInUser(req.body || {});
    res.setHeader("Set-Cookie", userSessionCookie(result.session));
    logAuthStep("login.session", "success");
    return res.json({
      authenticated: true,
      user: {
        id: result.user.id,
        email: result.user.email,
      },
    });
  } catch (error) {
    logAuthStep("login", "failure", error);
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
    logAuthStep("register", result.confirmationRequired ? "verification_required" : "success");
    return res.status(201).json({
      authenticated: Boolean(result.session),
      confirmationRequired: result.confirmationRequired,
      user: {
        id: result.user.id,
        email: result.user.email,
      },
    });
  } catch (error) {
    logAuthStep("register", "failure", error);
    return sendAuthError(res, error);
  }
});

router.post("/logout", async (req, res) => {
  try {
    await signOutUser(req.headers.cookie);
    const githubCookies = parseGitHubCookies(req.headers.cookie);
    await disconnectGitHubSession(githubCookies.synchron_github_session);
    logAuthStep("logout", "success");
  } catch (error) {
    logAuthStep("logout", "failure", error);
    logSafeError("[User logout]", error);
  }
  res.setHeader("Set-Cookie", [
    clearUserSessionCookie(),
    "synchron_github_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);
  return res.json({ authenticated: false });
});

export default router;
