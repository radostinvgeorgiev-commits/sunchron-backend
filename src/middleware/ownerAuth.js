import {
  getGitHubSession,
  isAuthorizedGitHubLogin,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";

export function resolveMemoryOwnerId(login, env = process.env) {
  const normalizedLogin =
    typeof login === "string" ? login.trim().toLocaleLowerCase("en-US") : "";
  if (!normalizedLogin) return "";

  // Preserve the existing single-owner production data while binding access
  // to the verified GitHub identity. Future authorized users receive their own
  // stable namespace instead of sharing the legacy owner id.
  if (isAuthorizedGitHubLogin(normalizedLogin, env)) {
    const legacyOwnerId =
      typeof env.MEMORY_OWNER_ID === "string" ? env.MEMORY_OWNER_ID.trim() : "";
    return legacyOwnerId || "primary-user";
  }

  return `github:${normalizedLogin}`;
}

export function createRequireOwnerSession({
  getSession = getGitHubSession,
} = {}) {
  return async function requireOwnerSession(req, res, next) {
    try {
      const cookies = parseGitHubCookies(req.headers.cookie);
      const session = await getSession(cookies.synchron_github_session);

      if (!session || !isAuthorizedGitHubLogin(session.login)) {
        return res.status(401).json({
          error:
            "Трябва да влезеш с разрешения GitHub профил, за да използваш личните данни и инструменти.",
          code: "OWNER_AUTH_REQUIRED",
          connectUrl: "/api/github/connect",
        });
      }

      req.owner = {
        id: session.login.toLocaleLowerCase("en-US"),
        login: session.login,
        memoryOwnerId: resolveMemoryOwnerId(session.login),
      };
      return next();
    } catch (error) {
      console.error("[Owner auth]", error);
      return res.status(503).json({
        error: "Проверката на собственика временно не е достъпна.",
        code: "OWNER_AUTH_UNAVAILABLE",
      });
    }
  };
}

export const requireOwnerSession = createRequireOwnerSession();
