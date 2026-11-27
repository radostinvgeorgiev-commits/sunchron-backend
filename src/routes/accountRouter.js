import express from "express";
import {
  AccountDataError,
  deleteAccount,
  exportAccountData,
} from "../services/accountDataService.js";
import {
  USER_SESSION_COOKIE,
  clearUserSessionCookie,
  decryptUserSession,
  parseCookies,
} from "../services/userAuthService.js";
import { logSafeError } from "../utils/safeLogging.js";

function sendError(res, error) {
  if (error instanceof AccountDataError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logSafeError("[Account] Failure", error);
  return res.status(503).json({
    error: "Действието временно не е достъпно. Опитай отново.",
    code: "ACCOUNT_DATA_UNAVAILABLE",
  });
}

export function createAccountRouter({
  exportData = exportAccountData,
  removeAccount = deleteAccount,
} = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/export", async (req, res) => {
    try {
      const data = await exportData(req.owner);
      const day = data.exportedAt.slice(0, 10);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="novarium-data-${day}.json"`,
      );
      return res.json(data);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/delete", async (req, res) => {
    try {
      const result = await removeAccount(req.owner, {
        password: req.body?.password,
        confirm: req.body?.confirm,
        session: decryptUserSession(parseCookies(req.headers.cookie)[USER_SESSION_COOKIE]),
      });
      res.append("Set-Cookie", clearUserSessionCookie());
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createAccountRouter();
