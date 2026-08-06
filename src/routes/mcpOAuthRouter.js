import express from "express";
import { resolveRequestIdentity } from "../middleware/ownerAuth.js";
import {
  createMcpAuthorizationCode,
  createMcpConsentToken,
  exchangeMcpToken,
  getMcpAuthorizationServerMetadata,
  getMcpProtectedResourceMetadata,
  McpOAuthError,
  recordMcpAuthorizationRuntimeStatus,
  resolveMcpConsentRequest,
  validateMcpAuthorizationRequest,
} from "../services/mcpOAuthService.js";

const formParser = express.urlencoded({ extended: false, limit: "16kb" });
const passThrough = (_req, _res, next) => next();
const SCOPE_LABELS = Object.freeze({
  "synchron:read": "Четене на разрешените данни и системни статуси",
  "synchron:agent.chat": "Разговор с AI CORE в собствения профил",
  "synchron:memory.write": "Потвърждавани промени в постоянната памет",
  "synchron:tasks.write": "Чернови, бележки и потвърждавани статуси на задачи",
  "synchron:github.write": "Потвърждавани промени в GitHub",
  "synchron:google.read":
    "Четене от свързаните Drive, Gmail, Calendar и Contacts",
  "synchron:google.write": "Чернови и потвърждавани Google промени",
  "synchron:audit.read": "Четене на безопасния журнал и последните грешки",
  "synchron:infrastructure.write": "Потвърждавани промени в инфраструктурата",
});

function noStore(res) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function preserveOAuthPopupHandoff(res) {
  res.set("Cross-Origin-Opener-Policy", "unsafe-none");
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

function consentPage(request, identity, consentToken) {
  const fields = {
    consent_token: consentToken,
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
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI CORE OAuth</title><style>body{font-family:system-ui;background:#08111f;color:#eef4ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;background:#111e31;padding:28px;border-radius:18px}button{font-size:18px;padding:12px 18px;border:0;border-radius:10px;margin-right:8px}.allow{background:#4f8cff;color:white}.deny{background:#26364d;color:white}</style></head><body><main class="card"><h1>Свързване на ChatGPT със AI CORE</h1><p>Влязъл си като <strong>${escapeHtml(identity.displayName || identity.id)}</strong>.</p><p>Клиент: <strong>${escapeHtml(request.clientName || "ChatGPT")}</strong> · callback: <strong>${escapeHtml(callbackHost)}</strong></p><p>ChatGPT иска следните права:</p><ul>${rights}</ul><p>Всяко действие за запис продължава да изисква отделно точно потвърждение.</p><p>Връзката може да се подновява, докато я използваш. Можеш да видиш правата и да спреш достъпа по всяко време от AI CORE → Разрешения.</p><form method="post" action="/oauth/authorize">${hidden}<button class="allow" name="decision" value="allow" type="submit">Разреши</button><button class="deny" name="decision" value="deny" type="submit">Откажи</button></form></main></body></html>`;
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
    preserveOAuthPopupHandoff(res);
    try {
      const request = await validateRequest(req.query);
      const identity = await resolveIdentity(req, res);
      noStore(res);
      if (!identity)
        return res.status(401).type("html").send(loginRequiredPage());
      const consentToken = createMcpConsentToken(request, identity);
      return res
        .type("html")
        .send(consentPage(request, identity, consentToken));
    } catch (error) {
      return oauthError(res, error);
    }
  });

  router.post(
    "/oauth/authorize",
    oauthRateLimiter,
    formParser,
    async (req, res) => {
      preserveOAuthPopupHandoff(res);
      try {
        const identity = await resolveIdentity(req, res);
        if (!identity) {
          throw new McpOAuthError(
            "Нужен е вход в AI CORE.",
            401,
            "access_denied",
          );
        }
        const request = resolveMcpConsentRequest(
          req.body?.consent_token,
          identity,
        );
        const callback = new URL(request.redirectUri);
        if (req.body?.decision !== "allow") {
          recordMcpAuthorizationRuntimeStatus({
            authorization: "redirected",
            decision: "deny",
          });
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("state", request.state);
          noStore(res);
          return res.redirect(callback.href);
        }
        const code = createMcpAuthorizationCode(request, identity);
        recordMcpAuthorizationRuntimeStatus({
          authorization: "redirected",
          decision: "allow",
        });
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", request.state);
        noStore(res);
        return res.redirect(callback.href);
      } catch (error) {
        recordMcpAuthorizationRuntimeStatus({
          authorization: "failed",
          decision: req.body?.decision === "allow" ? "allow" : "deny",
          errorCode:
            error instanceof McpOAuthError ? error.code : "server_error",
        });
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
