import { CANONICAL_ORIGIN } from "../config/publicOrigin.js";

// The old name of the site moves for good to novariumai.com (for РАДКО,
// 28.11.2026): a page opened on cloudaicore.com or www.cloudaicore.com, over
// https or http, answers 301 with the same path and query on
// https://novariumai.com.
//
// What is not a page stays on the old name, so nothing in use breaks:
// - /api/...: the sign-in returns Google and GitHub still have on record for
//   the old name, sign-in starts (startOnCallbackOrigin.js moves them
//   itself), the payment webhook and the calls of a page already open there;
// - /mcp, /.well-known/... and /oauth/...: the AI connectors (ChatGPT,
//   Claude) added with the old address, whose sign-in still lives there;
// - /health: the checks that watch the site;
// - the files a page loads (scripts, styles, pictures, the offline page), so
//   a page still open on the old name keeps working until it is reloaded;
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
  /^\/mcp(?:\/|$)/iu,
  /^\/\.well-known(?:\/|$)/iu,
  /^\/oauth(?:\/|$)/iu,
  /^\/health(?:\/|$)/iu,
];

// A page, not a file a page loads. A browser says what it loads; without that
// (a search engine, a link opened by another program) a page is a path
// without a file ending, or an .html file.
function isPage(req) {
  const dest = String(req.get("sec-fetch-dest") || "").trim().toLowerCase();
  if (dest) return dest === "document";
  const path = String(req.path || "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !name.includes(".") || /\.html?$/iu.test(name);
}

export function redirectOldSiteName({ origin = CANONICAL_ORIGIN, keepGoogleReviewPages = true } = {}) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const host = String(req.get("host") || "")
      .trim()
      .toLowerCase()
      .replace(/:\d+$/u, "");
    if (!OLD_SITE_HOSTS.has(host)) return next();
    const path = String(req.path || "");
    if (KEPT_ON_OLD_NAME.some((kept) => kept.test(path)) || !isPage(req)) return next();
    if (keepGoogleReviewPages && GOOGLE_REVIEW_PAGES.test(path)) return next();
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
    // Permanent for search engines; a browser asks again after a day.
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Vary", "Sec-Fetch-Dest");
    return res.redirect(301, location.href);
  };
}
