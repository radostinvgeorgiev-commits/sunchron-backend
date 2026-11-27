import { approveTesterAccess } from "./testerAccessService.js";
import {
  createAuthClient,
  isPublicRegistration,
  sessionPayload,
  UserAuthError,
} from "./userAuthService.js";

// "Вход с Facebook" and "Вход с Microsoft" through Identity Platform's own
// redirect flow: accounts:createAuthUri gives the provider address, the
// provider comes back to /api/auth/<name>/callback, and accounts:signInWithIdp
// swaps the code using the app secret stored in Identity Platform. This
// service never holds the provider secret. The Identity Platform session id
// is kept in a short-lived cookie, so a callback only completes in the
// browser that started it.

export const SIGN_IN_PROVIDERS = Object.freeze({
  facebook: Object.freeze({
    providerId: "facebook.com",
    label: "Facebook",
    flag: "FACEBOOK_SIGN_IN",
    enabledInCode: false,
    scopes: ["email", "public_profile"],
  }),
  microsoft: Object.freeze({
    providerId: "microsoft.com",
    label: "Microsoft",
    flag: "MICROSOFT_SIGN_IN",
    enabledInCode: false,
    scopes: ["openid", "email", "profile"],
  }),
});

const STATE_MAX_AGE_SECONDS = 600;

function provider(name) {
  const entry = Object.hasOwn(SIGN_IN_PROVIDERS, name) ? SIGN_IN_PROVIDERS[name] : null;
  if (!entry) throw new UserAuthError("Непознат начин за вход.", 404, "AUTH_PROVIDER_UNKNOWN");
  return entry;
}

function errorCode(name, suffix) {
  return `AUTH_${name.toUpperCase()}_${suffix}`;
}

export function isProviderSignInEnabled(name, env = process.env) {
  const entry = provider(name);
  const flag = String(env[entry.flag] || "").trim().toLowerCase();
  const enabled = flag ? flag === "on" : entry.enabledInCode;
  return Boolean(enabled && isPublicRegistration(env));
}

export function providerSignInStatus(env = process.env) {
  return Object.fromEntries(
    Object.keys(SIGN_IN_PROVIDERS).map((name) => [name, isProviderSignInEnabled(name, env)]),
  );
}

export function providerCallbackUri(name, env = process.env) {
  provider(name);
  const origin = String(env.PUBLIC_ORIGIN || "https://cloudaicore.com").replace(/\/+$/u, "");
  return `${origin}/api/auth/${name}/callback`;
}

function cookieName(name) {
  return `synchron_${name}_signin_session`;
}

function stateCookie(name, value, maxAge) {
  return [
    `${cookieName(name)}=${value}`,
    `Path=/api/auth/${name}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearProviderSignInCookie(name) {
  return stateCookie(name, "", 0);
}

function readCookie(name, cookieHeader = "") {
  for (const part of String(cookieHeader).split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === cookieName(name)) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

export async function startProviderSignIn(name, { env = process.env, client } = {}) {
  const entry = provider(name);
  if (!isProviderSignInEnabled(name, env)) {
    throw new UserAuthError(`Входът с ${entry.label} още не е включен.`, 503, errorCode(name, "DISABLED"));
  }
  const authClient = client || createAuthClient(env);
  const { data, error } = await authClient.auth.createProviderAuthUri({
    providerId: entry.providerId,
    continueUri: providerCallbackUri(name, env),
    scopes: entry.scopes,
  });
  if (error || !data) {
    const upstream = String(error?.upstreamCode || "");
    if (/OPERATION_NOT_ALLOWED|INVALID_PROVIDER_ID|CONFIGURATION_NOT_FOUND/u.test(upstream)) {
      throw new UserAuthError(
        `Входът с ${entry.label} още не е включен в Identity Platform.`,
        503,
        errorCode(name, "PROVIDER_DISABLED"),
      );
    }
    throw new UserAuthError(`Входът с ${entry.label} временно не е достъпен.`, 503, errorCode(name, "FAILED"));
  }
  return {
    url: data.authUri,
    cookie: stateCookie(name, encodeURIComponent(data.sessionId), STATE_MAX_AGE_SECONDS),
  };
}

export async function finishProviderSignIn(
  name,
  { query = {}, cookieHeader, originalUrl = "" },
  { env = process.env, client, approveAccess = approveTesterAccess } = {},
) {
  const entry = provider(name);
  if (!isProviderSignInEnabled(name, env)) {
    throw new UserAuthError(`Входът с ${entry.label} още не е включен.`, 503, errorCode(name, "DISABLED"));
  }
  if (query.error) {
    throw new UserAuthError(`Входът с ${entry.label} беше отказан.`, 401, errorCode(name, "CANCELLED"));
  }
  const sessionId = readCookie(name, cookieHeader);
  const search = String(originalUrl).includes("?") ? String(originalUrl).slice(String(originalUrl).indexOf("?")) : "";
  if (!sessionId || !search) {
    throw new UserAuthError(
      `Входът с ${entry.label} изтече или е отворен в друг прозорец. Опитай пак.`,
      400,
      errorCode(name, "STATE_INVALID"),
    );
  }

  const authClient = client || createAuthClient(env);
  const { data, error } = await authClient.auth.signInWithProviderRedirect({
    requestUri: `${providerCallbackUri(name, env)}${search}`,
    sessionId,
  });
  if (error || !data?.user || !data?.session) {
    const upstream = String(error?.upstreamCode || "");
    if (upstream === "NEED_CONFIRMATION") {
      throw new UserAuthError(
        `Имейлът от ${entry.label} вече има профил. Влез с „Продължи с Google“ или с паролата си.`,
        409,
        errorCode(name, "EXISTING_ACCOUNT"),
      );
    }
    if (/OPERATION_NOT_ALLOWED|INVALID_IDP_RESPONSE|INVALID_PROVIDER_ID/u.test(upstream)) {
      throw new UserAuthError(
        `Входът с ${entry.label} не беше потвърден. Опитай пак.`,
        400,
        errorCode(name, "PROVIDER_REJECTED"),
      );
    }
    throw new UserAuthError(`Входът с ${entry.label} временно не е достъпен.`, 503, errorCode(name, "FAILED"));
  }

  try {
    await approveAccess(data.user, { env, createOnly: true });
  } catch (cause) {
    throw new UserAuthError(
      cause?.message || "Достъпът до профила не можа да бъде потвърден.",
      Number(cause?.status) || 503,
      cause?.code || errorCode(name, "ACCESS_FAILED"),
    );
  }
  return {
    user: data.user,
    session: sessionPayload(data.session),
    created: data.isNewUser === true,
  };
}
