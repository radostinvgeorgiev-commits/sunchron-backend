import { CANONICAL_ORIGIN, publicOrigin } from "../config/publicOrigin.js";
import { SIGN_IN_PROVIDERS } from "../services/providerSignInService.js";
import { callbackForStart } from "./startOnCallbackOrigin.js";

// The old name of the site moves for good to novariumai.com (for РАДКО,
// 28.11.2026): a page opened on cloudaicore.com or www.cloudaicore.com, over
// https or http, answers 301 with the same path and query on
// https://novariumai.com.
//
// What is not a page stays on the old name, so nothing in use breaks:
// - /api/...: the sign-in returns Google and GitHub still have on record for
//   the old name, sign-in starts (startOnCallbackOrigin.js moves them
//   itself), the payment webhook and the calls of a page already open there;
// - the app's own calls outside /api (/chat, /memory, /permissions, /cloud,
//   /github, /calendar, /search) and the owner's lists under /admin;
// - /mcp, /.well-known/... and /oauth/...: the AI connectors (ChatGPT,
//   Claude) added with the old address, whose sign-in still lives there;
// - /health: the checks that watch the site;
// - the files a page loads (scripts, styles, pictures, the offline page), so
//   a page still open on the old name keeps working until it is reloaded;
// - while a sign-in still ends on the old name (GOOGLE_REDIRECT_URI,
//   GITHUB_REDIRECT_URI or the public address there), the pages of a person
//   signed in there: their
//   session belongs to that name only, so on novariumai.com they would be
//   signed out and their next sign-in would bring them back, round and round;
// - until Google approves the sign-in check, the three pages its reviewers
//   open on the old name: the start page, „Поверителност“ and „Общи условия“.
//   The check was sent for cloudaicore.com on 27.11.2026, and РАДКО's list
//   moves the old name after Google's approval; a start page that sends the
//   reviewers to another name could fail it.
export const OLD_SITE_HOSTS = new Set(["cloudaicore.com", "www.cloudaicore.com"]);
export const GOOGLE_REVIEW_PAGES = /^\/(?:(?:privacy|terms)\/?)?$/iu;

// Express matches routes without regard to case, so these do too.
const KEPT_ON_OLD_NAME = [
  /^\/api(?:\/|$)/iu,
  /^\/(?:chat|memory|permissions|cloud|github|calendar|search|admin)(?:\/|$)/iu,
  /^\/mcp(?:\/|$)/iu,
  /^\/\.well-known(?:\/|$)/iu,
  /^\/oauth(?:\/|$)/iu,
  /^\/health(?:\/|$)/iu,
];

// The cookies of a sign-in: a person's own (userAuthService.js) and the
// owner's GitHub one (ownerAuth.js).
const SIGNED_IN = /(?:^|;)\s*(?:synchron_user_session|synchron_github_session)=[^;\s]/u;

// A page, not a file a page loads or a call it makes. A browser says what it
// loads: Sec-Fetch-Dest "document" when it opens a page itself. In a browser
// that has opened the site before, the site's own service worker
// (public/sw.js) opens the page with fetch(event.request), and then the
// browser sends Sec-Fetch-Mode "navigate" with Sec-Fetch-Dest "empty" (seen
// in Chrome on 28.11: such a page stayed on the old name). A call a page
// makes is never "navigate". Without these headers (an older Safari, a search
// engine such as Bing, which asks for anything (*/*), a link opened by
// another program) it is a page by its path: no file ending, or an .html
// file. Every call a page makes is kept above or is a file (the scripts,
// /locales/*.json, /sw.js).
function isPage(req) {
  const dest = String(req.get("sec-fetch-dest") || "").trim().toLowerCase();
  const mode = String(req.get("sec-fetch-mode") || "").trim().toLowerCase();
  if (dest === "document") return true;
  if (mode === "navigate" && (!dest || dest === "empty")) return true;
  if (dest) return false;
  const path = String(req.path || "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !name.includes(".") || /\.html?$/iu.test(name);
}

function hostOf(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Where each sign-in really comes back (startOnCallbackOrigin.js moves its
// start there): Google's and GitHub's return addresses, and the other
// providers' callbacks on the public address.
const SIGN_IN_STARTS = ["google", "github", ...Object.keys(SIGN_IN_PROVIDERS)].map(
  (name) => `/api/auth/${name}/start`,
);

function signInEndsOnOldName(env) {
  return [publicOrigin(env), ...SIGN_IN_STARTS.map((start) => callbackForStart(start, env))].some((value) =>
    OLD_SITE_HOSTS.has(hostOf(value)),
  );
}

export function redirectOldSiteName({
  origin = CANONICAL_ORIGIN,
  keepGoogleReviewPages = true,
  env = process.env,
} = {}) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // "cloudaicore.com:443" and "cloudaicore.com." are the same name.
    const host = String(req.get("host") || "")
      .trim()
      .toLowerCase()
      .replace(/:\d+$/u, "")
      .replace(/\.$/u, "");
    if (!OLD_SITE_HOSTS.has(host)) return next();
    const path = String(req.path || "");
    if (KEPT_ON_OLD_NAME.some((kept) => kept.test(path)) || !isPage(req)) return next();
    if (keepGoogleReviewPages && GOOGLE_REVIEW_PAGES.test(path)) return next();
    if (SIGNED_IN.test(String(req.get("cookie") || "")) && signInEndsOnOldName(env)) return next();
    // Only a plain path ("/plans?x=1"), never an absolute or "//" target, and
    // the new address must stay on novariumai.com.
    const original = String(req.originalUrl || "");
    if (!original.startsWith("/") || original.startsWith("//")) return next();
    let location;
    try {
      location = new URL(original, origin);
    } catch {
      return next();
    }
    if (location.origin !== origin) return next();
    // Permanent for search engines, but never kept by a browser or a cache:
    // the answer depends on the sign-in and on what is asked for, and a
    // change here must reach everyone at once.
    res.set("Cache-Control", "no-store");
    return res.redirect(301, location.href);
  };
}
