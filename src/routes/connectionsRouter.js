import express from "express";
import {
  isMcpOAuthConfigured,
  listActiveMcpGrants,
  revokeMcpGrants,
  resolveMcpResourceUrl,
} from "../services/mcpOAuthService.js";
import { recordAuditEvent } from "../services/permissionService.js";
import { logSafeError } from "../utils/safeLogging.js";

// Lets every signed-in account see and disconnect the AI assistants (Claude,
// ChatGPT, Gemini, ...) that it connected to Novarium over MCP. Only the
// caller's own grants are listed or revoked.

const KNOWN_CLIENTS = Object.freeze([
  ["claude", "Claude"],
  ["anthropic", "Claude"],
  ["chatgpt", "ChatGPT"],
  ["openai", "ChatGPT"],
  ["gemini", "Gemini"],
  ["antigravity", "Antigravity"],
]);

export function connectionClientName(clientId) {
  const value = String(clientId || "").toLowerCase();
  for (const [needle, name] of KNOWN_CLIENTS) {
    if (value.includes(needle)) return name;
  }
  try {
    return new URL(String(clientId)).hostname || "AI клиент";
  } catch {
    return "AI клиент";
  }
}

function subjectOf(req) {
  return typeof req.owner?.id === "string" ? req.owner.id.trim() : "";
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

function safeConnection(grant) {
  const grantId = String(grant?.grantId || grant?.id || "").slice(0, 256);
  if (!grantId) return null;
  return {
    grantId,
    client: connectionClientName(grant.clientId),
    issuedAt: grant.issuedAt || null,
    lastUsedAt: grant.lastUsedAt || null,
  };
}

export function createConnectionsRouter({
  isConfigured = isMcpOAuthConfigured,
  listGrants = listActiveMcpGrants,
  revokeGrants = revokeMcpGrants,
  resourceUrl = resolveMcpResourceUrl,
  audit = recordAuditEvent,
} = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    noStore(res);
    const subject = subjectOf(req);
    if (!subject)
      return res
        .status(401)
        .json({ error: "Нужен е вход в профила.", code: "AUTH_REQUIRED" });
    try {
      const configured = Boolean(await isConfigured());
      const grants = configured ? await listGrants({ subject }) : [];
      return res.json({
        configured,
        mcpUrl: resourceUrl(),
        connections: (Array.isArray(grants) ? grants : [])
          .map(safeConnection)
          .filter(Boolean),
      });
    } catch (error) {
      logSafeError("[Connections] List failure", error);
      return res.status(503).json({
        error: "Връзките временно не могат да бъдат прочетени.",
        code: "CONNECTIONS_UNAVAILABLE",
      });
    }
  });

  router.post("/revoke", async (req, res) => {
    noStore(res);
    const subject = subjectOf(req);
    if (!subject)
      return res
        .status(401)
        .json({ error: "Нужен е вход в профила.", code: "AUTH_REQUIRED" });
    const grantId =
      typeof req.body?.grantId === "string" ? req.body.grantId.trim() : "";
    if (!grantId || grantId.length > 256)
      return res.status(400).json({
        error: "Избери връзка за прекъсване.",
        code: "INVALID_CONNECTION",
      });
    try {
      const result = await revokeGrants({ subject, grantId });
      const value =
        typeof result === "number"
          ? result
          : (result?.revoked ?? result?.revokedCount ?? result?.count);
      const revoked = Number.isSafeInteger(value) && value > 0 ? value : 0;
      if (!revoked)
        return res.status(404).json({
          error: "Връзката не е намерена или вече е прекъсната.",
          code: "CONNECTION_NOT_FOUND",
        });
      try {
        await audit({
          actor: subject,
          action: "oauth.revoke",
          capability: "oauth.manage",
          decision: "confirmed",
          outcome: "succeeded",
          resource: "mcp-connection",
          details: "single_grant",
          sessionId: subject,
        });
      } catch (error) {
        logSafeError("[Connections] Audit failure", error);
      }
      return res.json({ status: "ok", revoked });
    } catch (error) {
      logSafeError("[Connections] Revoke failure", error);
      return res.status(503).json({
        error: "Връзката временно не може да бъде прекъсната.",
        code: "CONNECTIONS_UNAVAILABLE",
      });
    }
  });

  return router;
}

export default createConnectionsRouter();
