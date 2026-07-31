import {
  getGitHubSession,
  isAuthorizedGitHubLogin,
  parseGitHubCookies,
} from "../services/githubOAuthService.js";
import {
  clearUserSessionCookie,
  resolveUserSession,
  userSessionCookie,
} from "../services/userAuthService.js";
import { logSafeError } from "../utils/safeLogging.js";

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

export async function resolveRequestIdentity(
  req,
  res,
  { getUserSession = resolveUserSession, getSession = getGitHubSession } = {},
) {
  const cookies = parseGitHubCookies(req.headers.cookie);
  if (cookies.synchron_github_session) {
    const githubSession = await getSession(cookies.synchron_github_session);
    if (githubSession && isAuthorizedGitHubLogin(githubSession.login)) {
      if (cookies.synchron_user_session) {
        res.append("Set-Cookie", clearUserSessionCookie());
      }
      return {
        id: githubSession.login.toLocaleLowerCase("en-US"),
        login: githubSession.login,
        displayName: "Радко",
        role: "owner",
        authProvider: "github",
        memoryOwnerId: resolveMemoryOwnerId(githubSession.login),
      };
    }
  }

  const userSession = await getUserSession(req.headers.cookie);
  if (userSession?.user) {
    if (userSession.refreshed && userSession.session) {
      res.append("Set-Cookie", userSessionCookie(userSession.session));
    }
    return {
      id: userSession.user.id,
      email: userSession.user.email,
      displayName: userSession.user.displayName,
      role: userSession.user.role,
      authProvider: "supabase",
      memoryOwnerId: userSession.user.memoryOwnerId,
    };
  }

  if (cookies.synchron_user_session) {
    res.append("Set-Cookie", clearUserSessionCookie());
  }

  return null;
}

export function createRequireOwnerSession({
  getSession = getGitHubSession,
  getUserSession = resolveUserSession,
} = {}) {
  return async function requireOwnerSession(req, res, next) {
    try {
      const identity = await resolveRequestIdentity(req, res, {
        getSession,
        getUserSession,
      });
      if (!identity) {
        return res.status(401).json({
          error:
            "Трябва да влезеш в потребителския си профил, за да използваш SYNCHRON-X.",
          code: "AUTH_REQUIRED",
        });
      }

      req.owner = identity;
      return next();
    } catch (error) {
      logSafeError("[Owner auth]", error);
      return res.status(503).json({
        error: "Проверката на собственика временно не е достъпна.",
        code: "OWNER_AUTH_UNAVAILABLE",
      });
    }
  };
}

export function requirePrimaryOwner(req, res, next) {
  if (req.owner?.role !== "owner") {
    return res.status(403).json({
      error: "Този инструмент е достъпен само за собственика.",
      code: "OWNER_ONLY",
    });
  }
  return next();
}

export const requireOwnerSession = createRequireOwnerSession();
