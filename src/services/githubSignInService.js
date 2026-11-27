import { randomBytes, timingSafeEqual } from "node:crypto";

import { approveTesterAccess } from "./testerAccessService.js";
import { exchangeGitHubCode, resolveGitHubRedirectUri } from "./githubOAuthService.js";
import {
  createAuthClient,
  isPublicRegistration,
  sessionPayload,
  UserAuthError,
} from "./userAuthService.js";

// "Вход с GitHub" for every person: the browser goes to GitHub, comes back
// with a one-time code, the server swaps it for a GitHub access token and
// hands that to Identity Platform (accounts:signInWithIdp, github.com), which
// signs the person in or creates the account. It reuses the GitHub OAuth app
// and its registered callback (/api/github/callback); a separate state cookie
// tells a sign-in apart from the owner's own GitHub connection.

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_SIGN_IN_STATE_COOKIE = "synchron_github_signin_state";
const STATE_MAX_AGE_SECONDS = 600;

// Switched on in code once the GitHub provider is enabled in Identity
// Platform; GITHUB_SIGN_IN=on|off in the environment overrides it.
const GITHUB_SIGN_IN_ENABLED_IN_CODE = true;

function clientId(env) {
  return String(env.GITHUB_CLIENT_ID || "").trim();
}

export function isGitHubSignInEnabled(env = process.env) {
  const flag = String(env.GITHUB_SIGN_IN || "").trim().toLowerCase();
  const enabled = flag ? flag === "on" : GITHUB_SIGN_IN_ENABLED_IN_CODE;
  return Boolean(
    enabled &&
      clientId(env) &&
      String(env.GITHUB_CLIENT_SECRET || "").trim() &&
      isPublicRegistration(env),
  );
}

function stateCookie(value, maxAge) {
  return [
    `${GITHUB_SIGN_IN_STATE_COOKIE}=${value}`,
    "Path=/api",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearGitHubSignInStateCookie() {
  return stateCookie("", 0);
}

function readStateCookie(cookieHeader = "") {
  for (const part of String(cookieHeader).split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GITHUB_SIGN_IN_STATE_COOKIE) return rest.join("=");
  }
  return "";
}

function sameState(expected, actual) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(actual || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// True when this callback belongs to a sign-in started here, not to the
// owner's GitHub connection.
export function isGitHubSignInCallback({ state, cookieHeader } = {}) {
  return sameState(readStateCookie(cookieHeader), state);
}

export function startGitHubSignIn({ env = process.env } = {}) {
  if (!isGitHubSignInEnabled(env)) {
    throw new UserAuthError("Входът с GitHub още не е включен.", 503, "AUTH_GITHUB_DISABLED");
  }
  const state = randomBytes(24).toString("base64url");
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: resolveGitHubRedirectUri(env.GITHUB_REDIRECT_URI),
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  }).toString();
  return { url: url.toString(), cookie: stateCookie(state, STATE_MAX_AGE_SECONDS) };
}

export async function finishGitHubSignIn(
  { code, state, error, cookieHeader },
  {
    env = process.env,
    exchangeCode = exchangeGitHubCode,
    client,
    approveAccess = approveTesterAccess,
  } = {},
) {
  if (!isGitHubSignInEnabled(env)) {
    throw new UserAuthError("Входът с GitHub още не е включен.", 503, "AUTH_GITHUB_DISABLED");
  }
  if (error) {
    throw new UserAuthError("Входът с GitHub беше отказан.", 401, "AUTH_GITHUB_CANCELLED");
  }
  if (!sameState(readStateCookie(cookieHeader), state) || typeof code !== "string" || !code) {
    throw new UserAuthError(
      "Входът с GitHub изтече или е отворен в друг прозорец. Опитай пак.",
      400,
      "AUTH_GITHUB_STATE_INVALID",
    );
  }

  let accessToken;
  try {
    accessToken = (await exchangeCode(code))?.access_token;
    if (typeof accessToken !== "string" || !accessToken) throw new Error("token");
  } catch {
    throw new UserAuthError("GitHub не потвърди входа. Опитай пак.", 502, "AUTH_GITHUB_TOKEN_FAILED");
  }

  const authClient = client || createAuthClient(env);
  const { data, error: idpError } = await authClient.auth.signInWithGitHubAccessToken({
    accessToken,
    requestUri: resolveGitHubRedirectUri(env.GITHUB_REDIRECT_URI),
  });
  if (idpError || !data?.user || !data?.session) {
    const upstream = String(idpError?.upstreamCode || "");
    if (upstream === "NEED_CONFIRMATION") {
      throw new UserAuthError(
        "Имейлът от GitHub вече има профил. Влез с „Продължи с Google“ или с паролата си.",
        409,
        "AUTH_GITHUB_EXISTING_ACCOUNT",
      );
    }
    if (/OPERATION_NOT_ALLOWED|INVALID_IDP_RESPONSE/u.test(upstream)) {
      throw new UserAuthError(
        "Входът с GitHub още не е включен в Identity Platform.",
        503,
        "AUTH_GITHUB_PROVIDER_DISABLED",
      );
    }
    throw new UserAuthError("Входът с GitHub временно не е достъпен.", 503, "AUTH_GITHUB_FAILED");
  }

  try {
    await approveAccess(data.user, { env, createOnly: true });
  } catch (cause) {
    throw new UserAuthError(
      cause?.message || "Достъпът до профила не можа да бъде потвърден.",
      Number(cause?.status) || 503,
      cause?.code || "AUTH_GITHUB_ACCESS_FAILED",
    );
  }
  return {
    user: data.user,
    session: sessionPayload(data.session),
    created: data.isNewUser === true,
  };
}
