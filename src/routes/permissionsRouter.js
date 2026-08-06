import express from "express";
import {
  evaluatePermission,
  listAuditEvents,
  listPermissions,
  recordAuditEvent,
} from "../services/permissionService.js";
import {
  isMcpOAuthConfigured,
  listActiveMcpGrants,
  revokeMcpGrants,
} from "../services/mcpOAuthService.js";
import { logSafeError } from "../utils/safeLogging.js";

function noStore(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

function ownerSubject(req) {
  return typeof req.owner?.id === "string" ? req.owner.id.trim() : "";
}

function cleanText(value, maxLength = 2048) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requestedGrantId(body) {
  if (!Object.hasOwn(body || {}, "grantId")) {
    return { provided: false, value: null };
  }
  if (typeof body.grantId !== "string") {
    return { provided: true, value: null };
  }
  const value = body.grantId.trim();
  return {
    provided: true,
    value:
      value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value) ? value : null,
  };
}

function safeGrant(grant) {
  const grantId = cleanText(grant?.grantId || grant?.id, 256);
  const clientId = cleanText(grant?.clientId, 2048);
  const scopes = Array.isArray(grant?.scopes)
    ? grant.scopes
        .map((scope) => cleanText(scope, 128))
        .filter(Boolean)
        .slice(0, 32)
    : [];
  const issuedAt = cleanText(grant?.issuedAt, 64);
  const lastUsedAt = cleanText(grant?.lastUsedAt, 64);
  const expiresAt = cleanText(grant?.expiresAt, 64);

  return {
    grantId,
    clientId,
    scopes,
    issuedAt,
    lastUsedAt,
    expiresAt,
  };
}

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch (error) {
    logSafeError("[Permissions OAuth] Audit failure", error);
  }
}

function revokedCount(result) {
  const value =
    typeof result === "number"
      ? result
      : result?.revoked ?? result?.revokedCount ?? result?.count;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function oauthError(res, error, action) {
  logSafeError(`[Permissions OAuth] ${action} failure`, error);
  if (error?.code === "MCP_OAUTH_GRANT_NOT_FOUND") {
    return res.status(404).json({
      error: "ChatGPT връзката не е намерена или вече е прекъсната.",
      code: "MCP_OAUTH_GRANT_NOT_FOUND",
    });
  }

  return res.status(503).json({
    error:
      action === "list"
        ? "ChatGPT връзките временно не са достъпни."
        : "ChatGPT достъпът временно не може да бъде прекъснат.",
    code:
      action === "list"
        ? "MCP_OAUTH_GRANTS_UNAVAILABLE"
        : "MCP_OAUTH_REVOCATION_UNAVAILABLE",
  });
}

export function createPermissionsRouter({
  evaluate = evaluatePermission,
  listAudit = listAuditEvents,
  listPolicy = listPermissions,
  isOAuthConfigured = isMcpOAuthConfigured,
  listGrants = listActiveMcpGrants,
  revokeGrants = revokeMcpGrants,
  recordAudit = recordAuditEvent,
} = {}) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json({
      defaultDecision: "deny",
      permissions: listPolicy(),
    });
  });

  router.get("/check", (req, res) => {
    res.json(evaluate(req.query.action));
  });

  router.get("/audit", async (req, res) => {
    try {
      const events = await listAudit(req.query.limit);
      res.json({ events });
    } catch (error) {
      logSafeError("[Audit] Read failure", error);
      res.status(503).json({
        error: "Дневникът на действията временно не е достъпен.",
        code: "AUDIT_UNAVAILABLE",
      });
    }
  });

  router.get("/oauth/chatgpt", async (req, res) => {
    noStore(res);
    const subject = ownerSubject(req);
    if (!subject) {
      return res.status(401).json({
        error: "Нужен е вход в профила.",
        code: "AUTH_REQUIRED",
      });
    }

    try {
      const configured = Boolean(await isOAuthConfigured());
      const grants = configured ? await listGrants({ subject }) : [];
      if (!Array.isArray(grants)) throw new TypeError("Invalid OAuth grants");
      const safeGrants = grants.map(safeGrant).filter((grant) => grant.grantId);
      return res.json({
        configured,
        connected: safeGrants.length > 0,
        grants: safeGrants,
      });
    } catch (error) {
      return oauthError(res, error, "list");
    }
  });

  router.post("/oauth/chatgpt/revoke", async (req, res) => {
    noStore(res);
    const subject = ownerSubject(req);
    if (!subject) {
      return res.status(401).json({
        error: "Нужен е вход в профила.",
        code: "AUTH_REQUIRED",
      });
    }

    const requestedGrant = requestedGrantId(req.body);
    const grantId = requestedGrant.value;
    const revokeAll = req.body?.all === true;
    if (
      (requestedGrant.provided && !grantId) ||
      Number(Boolean(grantId)) + Number(revokeAll) !== 1
    ) {
      return res.status(400).json({
        error: "Избери една ChatGPT връзка или потвърди прекъсване на всички.",
        code: "INVALID_MCP_OAUTH_REVOCATION_TARGET",
      });
    }

    try {
      const result = await revokeGrants({
        subject,
        ...(grantId ? { grantId } : {}),
      });
      const revoked = revokedCount(result);
      if (grantId && revoked === 0) {
        return res.status(404).json({
          error: "ChatGPT връзката не е намерена или вече е прекъсната.",
          code: "MCP_OAUTH_GRANT_NOT_FOUND",
        });
      }
      await safeAudit(recordAudit, {
        actor: subject,
        action: "oauth.revoke",
        capability: "oauth.manage",
        decision: "confirmed",
        outcome: "succeeded",
        resource: "chatgpt-mcp",
        details: grantId ? "single_grant" : "all_grants",
        sessionId: subject,
      });
      return res.json({
        status: "ok",
        revoked,
        grantId: grantId || null,
      });
    } catch (error) {
      return oauthError(res, error, "revoke");
    }
  });

  return router;
}

export default createPermissionsRouter();
