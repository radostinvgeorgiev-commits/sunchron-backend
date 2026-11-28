import { resolveGitHubRedirectUri } from "../services/githubOAuthService.js";
import { googleSignInRedirectUri } from "../services/googleSignInService.js";
import {
  providerCallbackUri,
  SIGN_IN_PROVIDERS,
} from "../services/providerSignInService.js";

// The site answers on two names, novariumai.com and the old cloudaicore.com.
// A sign-in or a connection keeps its state in a cookie on the name where it
// starts, and the provider comes back to the name in its return address. A
// cookie belongs to one name, so a start on the other name fails on return.
// Each start address therefore first moves to the name its own provider comes
// back to: Google's sign-in and connection to GOOGLE_REDIRECT_URI, GitHub's to
// GITHUB_REDIRECT_URI, Facebook and Microsoft to their callback on the public
// address. Then the cookie is where the provider returns, whichever name the
// person opened, before and after the return addresses move to novariumai.com.
const SITE_HOSTS = new Set([
  "cloudaicore.com",
  "www.cloudaicore.com",
  "novariumai.com",
  "www.novariumai.com",
]);
const PROVIDER_START = /^\/api\/auth\/([a-z]+)\/start$/u;

// Where the provider of this start address comes back, or "" when the path is
// not a start address. Express matches routes without regard to case or a
// trailing slash, so the path is compared the same way.
export function callbackForStart(path, env = process.env) {
  const clean = String(path || "").toLowerCase().replace(/\/+$/u, "");
  if (clean === "/api/auth/google/start") return googleSignInRedirectUri(env);
  if (clean === "/api/google/connect") return String(env.GOOGLE_REDIRECT_URI || "").trim();
  if (clean === "/api/auth/github/start" || clean === "/api/github/connect") {
    return resolveGitHubRedirectUri(env.GITHUB_REDIRECT_URI);
  }
  const name = PROVIDER_START.exec(clean)?.[1];
  return name && Object.hasOwn(SIGN_IN_PROVIDERS, name) ? providerCallbackUri(name, env) : "";
}

export function startOnCallbackOrigin(env = process.env) {
  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const host = String(req.get("host") || "").trim().toLowerCase();
    if (!SITE_HOSTS.has(host)) return next();
    let target;
    try {
      target = new URL(callbackForStart(req.path, env));
    } catch {
      return next();
    }
    // Only between the site's own names, and never to the name it is on.
    if (!SITE_HOSTS.has(target.host) || target.host === host) return next();
    return res.redirect(302, `${target.origin}${req.originalUrl}`);
  };
}
