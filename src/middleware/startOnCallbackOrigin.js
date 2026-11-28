import { resolveGitHubRedirectUri } from "../services/githubOAuthService.js";
import { googleSignInRedirectUri } from "../services/googleSignInService.js";
import {
  providerCallbackUri,
  SIGN_IN_PROVIDERS,
} from "../services/providerSignInService.js";

// The site answers on two names, novariumai.com and the old cloudaicore.com.
// A sign-in keeps its state in a cookie on the name where it starts, and the
// provider comes back to the name in its return address. A cookie belongs to
// one name, so a sign-in started on the other name fails on return. Each
// sign-in start therefore first moves to the name its own provider comes back
// to: Google's to GOOGLE_REDIRECT_URI, GitHub's to GITHUB_REDIRECT_URI,
// Facebook and Microsoft to their callback on the public address. This holds
// before and after the return addresses move to novariumai.com.
//
// The moved address carries moved=1. A Google sign-in started that way never
// links the owner (src/routes/userAuthRouter.js): the person pressed the
// button on a page where nobody was signed in, so an owner session on the
// other name says nothing about who they are.
//
// Connecting Google or GitHub (/api/google/connect, /api/github/connect) does
// not move: it runs for the account signed in where the person pressed the
// button, and on the other name that can be someone else's account. Its
// return comes back to where it was pressed instead (returnToConnectStart.js).
export const SITE_HOSTS = new Set([
  "cloudaicore.com",
  "www.cloudaicore.com",
  "novariumai.com",
  "www.novariumai.com",
]);
const SIGN_IN_START = /^\/api\/auth\/([a-z]+)\/start$/u;

// Where the provider of this sign-in start comes back, or "" when the path is
// not a sign-in start. Express matches routes without regard to case and with
// one optional trailing slash, so the path is compared the same way.
export function callbackForStart(path, env = process.env) {
  const clean = String(path || "").toLowerCase().replace(/\/$/u, "");
  const name = SIGN_IN_START.exec(clean)?.[1];
  if (name === "google") return googleSignInRedirectUri(env);
  if (name === "github") return resolveGitHubRedirectUri(env.GITHUB_REDIRECT_URI);
  return name && Object.hasOwn(SIGN_IN_PROVIDERS, name) ? providerCallbackUri(name, env) : "";
}

export function startOnCallbackOrigin(env = process.env) {
  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const callback = callbackForStart(req.path, env);
    if (!callback) return next();
    const host = String(req.get("host") || "").trim().toLowerCase();
    if (!SITE_HOSTS.has(host)) return next();
    // Only a plain path ("/api/..."), never an absolute or "//" request target.
    const original = String(req.originalUrl || "");
    if (!original.startsWith("/") || original.startsWith("//")) return next();
    let target;
    let location;
    try {
      target = new URL(callback);
      location = new URL(original, target.origin);
    } catch {
      return next();
    }
    // Only to the site's own names over https, never to the name it is on,
    // and the address must stay on that name.
    if (
      target.protocol !== "https:" ||
      !SITE_HOSTS.has(target.host) ||
      target.host === host ||
      location.origin !== target.origin
    ) {
      return next();
    }
    location.searchParams.set("moved", "1");
    res.set("Cache-Control", "no-store");
    return res.redirect(302, location.href);
  };
}
