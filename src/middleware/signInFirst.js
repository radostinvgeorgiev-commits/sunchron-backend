import { publicOrigin } from "../config/publicOrigin.js";
import { resolveRequestIdentity } from "./ownerAuth.js";
import { SITE_HOSTS } from "./startOnCallbackOrigin.js";

// A connect link opened where nobody is signed in (RADKO 28.11: the link from
// the chat on the phone showed bare JSON „AUTH_REQUIRED“ and Safari saved it
// as connect.json). Such an opening goes to „Вход с Google“ first and, after
// the sign-in, back to the same connect link. Only these exact links come
// back; anything else after a sign-in lands on the start page as before.
const RETURN_PATH = /^\/api\/google\/connect(?:\?add=[a-z]{1,20})?$/u;
export const AFTER_SIGN_IN_COOKIE = "novarium_after_signin";

export function safeReturnPath(value) {
  const path = String(value || "");
  return RETURN_PATH.test(path) ? path : "";
}

export function afterSignInCookie(path) {
  return `${AFTER_SIGN_IN_COOKIE}=${encodeURIComponent(path)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearAfterSignInCookie() {
  return `${AFTER_SIGN_IN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// The return path stored by a connect link, or "".
export function afterSignInPath(cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== AFTER_SIGN_IN_COOKIE) continue;
    try {
      return safeReturnPath(decodeURIComponent(rest.join("=")));
    } catch {
      return "";
    }
  }
  return "";
}

export function signInFirst({ env = process.env, identify = resolveRequestIdentity } = {}) {
  return async (req, res, next) => {
    if (req.method !== "GET") return next();
    const path = safeReturnPath(req.originalUrl);
    if (!path) return next();
    let identity = null;
    try {
      identity = await identify(req, res);
    } catch {
      return next();
    }
    if (identity) return next();
    // The sign-in finishes on the site's public address; the return cookie
    // must live there, so the link first moves to that address.
    const host = String(req.get("host") || "").trim().toLowerCase();
    const origin = publicOrigin(env);
    let publicHost = "";
    try {
      publicHost = new URL(origin).host;
    } catch {
      publicHost = "";
    }
    if (SITE_HOSTS.has(host) && publicHost && host !== publicHost) {
      return res.redirect(302, `${origin}${path}`);
    }
    res.append("Set-Cookie", afterSignInCookie(path));
    return res.redirect(302, "/api/auth/google/start");
  };
}
