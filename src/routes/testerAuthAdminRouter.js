import express from "express";

import {
  getTesterInviteCode,
  isTesterRegistrationEnabled,
  isUserAuthConfigured,
  isUserRegistrationEnabled,
} from "../services/userAuthService.js";

export function createTesterAuthAdminRouter({ env = process.env } = {}) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  });

  router.get("/status", (_req, res) =>
    res.json({
      configured: isUserAuthConfigured(env),
      registrationEnabled: isUserRegistrationEnabled(env),
      provider: "google-identity-platform",
      managedIn: "google-cloud-console",
    }),
  );

  router.get("/invite-code", (_req, res) => {
    const inviteCode = getTesterInviteCode(env);
    if (!isTesterRegistrationEnabled(env) || !inviteCode) {
      return res.status(404).json({
        error: "Кодът за тестов достъп още не е активен.",
        code: "TESTER_INVITE_NOT_CONFIGURED",
      });
    }
    return res.json({ inviteCode });
  });

  return router;
}

export default createTesterAuthAdminRouter();
