import { randomBytes, timingSafeEqual } from "node:crypto";

import { approveTesterAccess } from "./testerAccessService.js";
import {
  createAuthClient,
  isPublicRegistration,
  sessionPayload,
  UserAuthError,
} from "./userAuthService.js";

// "Вход с Google": the browser goes to Google, comes back with a one-time
// code, the server swaps it for a Google ID token and hands that to Identity
// Platform (accounts:signInWithIdp), which signs the person in or creates the
// account. No password and no confirmation email are involved.

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SIGN_IN_STATE_COOKIE = "synchron_google_signin_state";
const STATE_MAX_AGE_SECONDS = 600;
const CALLBACK_PATH = "/api/auth/google/callback";

// Switched on in code once the Google provider is enabled in Identity
// Platform; GOOGLE_SIGN_IN=on|off in the environment overrides it.
const GOOGLE_SIGN_IN_ENABLED_IN_CODE = false;

function clientId(env) {
  return String(env.GOOGLE_SIGN_IN_CLIENT_ID || env.GOOGLE_CLIENT_ID || "").trim();
}
function clientSecret(env) {
  return String(env.GOOGLE_SIGN_IN_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || "").trim();
}

export function isGoogleSignInEnabled(env = process.env) {
  const flag = String(env.GOOGLE_SIGN_IN || "").trim().toLowerCase();
  const enabled = flag ? flag === "on" : GOOGLE_SIGN_IN_ENABLED_IN_CODE;
  return Boolean(enabled && clientId(env) && clientSecret(env) && isPublicRegistration(env));
}

export function googleSignInRedirectUri(env = process.env) {
  const origin = String(env.PUBLIC_ORIGIN || "https://cloudaicore.com").replace(/\/+$/u, "");
  return `${origin}${CALLBACK_PATH}`;
}

function stateCookie(value, maxAge) {
  return [
    `${GOOGLE_SIGN_IN_STATE_COOKIE}=${value}`,
    "Path=/api/auth/google",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearGoogleSignInStateCookie() {
  return stateCookie("", 0);
}

export function startGoogleSignIn({ env = process.env } = {}) {
  if (!isGoogleSignInEnabled(env)) {
    throw new UserAuthError("Входът с Google още не е включен.", 503, "AUTH_GOOGLE_DISABLED");
  }
  const state = randomBytes(24).toString("base64url");
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: googleSignInRedirectUri(env),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), cookie: stateCookie(state, STATE_MAX_AGE_SECONDS) };
}

function readStateCookie(cookieHeader = "") {
  for (const part of String(cookieHeader).split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GOOGLE_SIGN_IN_STATE_COOKIE) return rest.join("=");
  }
  return "";
}

function sameState(expected, actual) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(actual || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function finishGoogleSignIn(
  { code, state, error, cookieHeader },
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    client,
    approveAccess = approveTesterAccess,
  } = {},
) {
  if (!isGoogleSignInEnabled(env)) {
    throw new UserAuthError("Входът с Google още не е включен.", 503, "AUTH_GOOGLE_DISABLED");
  }
  if (error) {
    throw new UserAuthError("Входът с Google беше отказан.", 401, "AUTH_GOOGLE_CANCELLED");
  }
  if (!sameState(readStateCookie(cookieHeader), state) || typeof code !== "string" || !code) {
    throw new UserAuthError(
      "Входът с Google изтече или е отворен в друг прозорец. Опитай пак.",
      400,
      "AUTH_GOOGLE_STATE_INVALID",
    );
  }

  const redirectUri = googleSignInRedirectUri(env);
  let tokens;
  try {
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(env),
        client_secret: clientSecret(env),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    tokens = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokens.id_token !== "string") throw new Error("token");
  } catch {
    throw new UserAuthError("Google не потвърди входа. Опитай пак.", 502, "AUTH_GOOGLE_TOKEN_FAILED");
  }

  const authClient = client || createAuthClient(env);
  const { data, error: idpError } = await authClient.auth.signInWithGoogleIdToken({
    idToken: tokens.id_token,
    requestUri: redirectUri,
  });
  if (idpError || !data?.user || !data?.session) {
    const upstream = String(idpError?.upstreamCode || "");
    if (/OPERATION_NOT_ALLOWED|INVALID_IDP_RESPONSE/u.test(upstream)) {
      throw new UserAuthError(
        "Входът с Google още не е включен в Identity Platform.",
        503,
        "AUTH_GOOGLE_PROVIDER_DISABLED",
      );
    }
    throw new UserAuthError("Входът с Google временно не е достъпен.", 503, "AUTH_GOOGLE_FAILED");
  }

  try {
    // createOnly accepts an already approved record and refuses a revoked one.
    await approveAccess(data.user, { env, createOnly: true });
  } catch (cause) {
    throw new UserAuthError(
      cause?.message || "Достъпът до профила не можа да бъде потвърден.",
      Number(cause?.status) || 503,
      cause?.code || "AUTH_GOOGLE_ACCESS_FAILED",
    );
  }
  return {
    user: data.user,
    session: sessionPayload(data.session),
    created: data.isNewUser === true,
  };
}
