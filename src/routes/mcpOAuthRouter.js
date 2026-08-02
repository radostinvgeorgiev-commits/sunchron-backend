import express from "express";
import { randomUUID } from "node:crypto";
import { resolveRequestIdentity } from "../middleware/ownerAuth.js";
import {
  createMcpAuthorizationCode,
  exchangeMcpToken,
  getMcpAuthorizationServerMetadata,
  getMcpProtectedResourceMetadata,
  McpOAuthError,
  resolveMcpIssuerUrl,
  validateMcpAuthorizationRequest,
} from "../services/mcpOAuthService.js";

const formParser = express.urlencoded({ extended: false, limit: "16kb" });
const passThrough = (_req, _res, next) => next();
const SCOPE_LABELS = Object.freeze({
  "synchron:read": "Четене на разрешените данни и системни статуси",
  "synchron:github.write": "Потвърждавани промени в GitHub",
  "synchron:infrastructure.write": "Потвърждавани промени в инфраструктурата",
});

function noStore(res) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function oauthError(res, error) {
  noStore(res);
  const known = error instanceof McpOAuthError;
  return res.status(known ? error.status : 500).json({
    error: known ? error.code : "server_error",
    error_description: known
      ? error.description
      : "AI CORE OAuth временно не е достъпен.",
  });
}

function consentPage(request, identity, csrfToken) {
  const fields = {
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    resource: request.resource,
    scope: request.scopes.join(" "),
    csrf_token: csrfToken,
  };
  const hidden = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const rights = request.scopes
    .map(
      (scope) =>
        `<li>${escapeHtml(SCOPE_LABELS[scope] || scope)} <small>(${escapeHtml(scope)})</small></li>`,
    )
    .join("");
  const callbackHost = new URL(request.redirectUri).hostname;
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI CORE OAuth</title><style>body{font-family:system-ui;background:#08111f;color:#eef4ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;background:#111e31;padding:28px;border-radius:18px}button{font-size:18px;padding:12px 18px;border:0;border-radius:10px;margin-right:8px}.allow{background:#4f8cff;color:white}.deny{background:#26364d;color:white}</style></head><body><main class="card"><h1>Свързване на ChatGPT със AI CORE</h1><p>Влязъл си като <strong>${escapeHtml(identity.displayName || identity.id)}</strong>.</p><p>Клиент: <strong>${escapeHtml(request.clientName || "ChatGPT")}</strong> · callback: <strong>${escapeHtml(callbackHost)}</strong></p><p>ChatGPT иска следните права:</p><ul>${rights}</ul><p>Всяко действие за запис продължава да изисква отделно точно потвърждение.</p><form method="post" action="/oauth/authorize">${hidden}<button class="allow" name="decision" value="allow" type="submit">Разреши</button><button class="deny" name="decision" value="deny" type="submit">Откажи</button></form></main></body></html>`;
}

function loginRequiredPage() {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход в AI CORE</title></head><body><main><h1>Нужен е вход в AI CORE</h1><p>Отвори AI CORE, влез в профила си, после се върни и обнови тази страница.</p><p><a href="/" target="_blank" rel="noopener">Отвори AI CORE</a></p></main></body></html>`;
}

export function createMcpOAuthRouter({
  oauthRateLimiter = passThrough,
  resolveIdentity = resolveRequestIdentity,
  validateRequest = validateMcpAuthorizationRequest,
} = {}) {
  const router = express.Router();

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    noStore(res);
    res.json(getMcpProtectedResourceMetadata());
  });

  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    noStore(res);
    res.json(getMcpProtectedResourceMetadata());
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    noStore(res);
    res.json(getMcpAuthorizationServerMetadata());
  });

  router.get("/oauth/authorize", oauthRateLimiter, async (req, res) => {
    try {
      const request = await validateRequest(req.query);
      const identity = await resolveIdentity(req, res);
      noStore(res);
      if (!identity)
        return res.status(401).type("html").send(loginRequiredPage());
      const csrfToken = randomUUID();
      res.append(
        "Set-Cookie",
        `synchron_mcp_csrf=${csrfToken}; Path=/oauth; HttpOnly; Secure; SameSite=Strict; Max-Age=600`,
      );
      return res.type("html").send(consentPage(request, identity, csrfToken));
    } catch (error) {
      return oauthError(res, error);
    }
  });

  router.post(
    "/oauth/authorize",
    oauthRateLimiter,
    formParser,
    async (req, res) => {
      try {
        const identity = await resolveIdentity(req, res);
        if (!identity) {
          throw new McpOAuthError(
            "Нужен е вход в AI CORE.",
            401,
            "access_denied",
          );
        }
        const csrfCookie = String(req.headers.cookie || "")
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("synchron_mcp_csrf="))
          ?.slice("synchron_mcp_csrf=".length);
        if (!csrfCookie || csrfCookie !== req.body?.csrf_token) {
          throw new McpOAuthError(
            "Невалидно потвърждение.",
            403,
            "access_denied",
          );
        }
        const request = await validateRequest(req.body);
        const callback = new URL(request.redirectUri);
        if (req.body?.decision !== "allow") {
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("state", request.state);
          callback.searchParams.set("iss", resolveMcpIssuerUrl());
          return res.redirect(callback.href);
        }
        const code = createMcpAuthorizationCode(request, identity);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", request.state);
        callback.searchParams.set("iss", resolveMcpIssuerUrl());
        res.append(
          "Set-Cookie",
          "synchron_mcp_csrf=; Path=/oauth; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        );
        noStore(res);
        return res.redirect(callback.href);
      } catch (error) {
        return oauthError(res, error);
      }
    },
  );

  router.post(
    "/oauth/token",
    oauthRateLimiter,
    formParser,
    async (req, res) => {
      try {
        const token = await exchangeMcpToken(req.body || {});
        noStore(res);
        return res.json(token);
      } catch (error) {
        return oauthError(res, error);
      }
    },
  );

  return router;
}
