import { SITE_HOSTS } from "./startOnCallbackOrigin.js";

// The site answers on two names, novariumai.com and the old cloudaicore.com
// (see startOnCallbackOrigin.js). Connecting Google or GitHub („Свържи
// Google“, „Разреши Gmail“) runs for the account signed in where the person
// pressed the button, so it starts there and its state cookie stays there.
// The provider comes back to the name in its return address
// (GOOGLE_REDIRECT_URI, GITHUB_REDIRECT_URI). A cookie belongs to one name,
// so a connect pressed on the other name failed on return: RADKO's „Свържи
// Google“ on novariumai.com, 28.11.2026 05:45 UTC, INVALID_OAUTH_STATE.
//
// So the state carries a mark of the name where the connect started, and a
// callback whose own cookie does not hold that state sends the browser once
// to the same callback on that name. There the cookie checks the state as
// before, and the connect finishes for the account signed in there. The
// address goes only to the site's own names over https, and the token swap
// keeps the configured return address, as Google and GitHub require. This
// holds before and after the return addresses move to novariumai.com.

const MARKS = Object.freeze({
  "novariumai.com": "n",
  "www.novariumai.com": "wn",
  "cloudaicore.com": "c",
  "www.cloudaicore.com": "wc",
});
const HOSTS_BY_MARK = Object.freeze(
  Object.fromEntries(Object.entries(MARKS).map(([host, mark]) => [mark, host])),
);
// The nonce is base64url, which has no dot, so the mark is read only at the end.
const MARK = /\.at-(n|wn|c|wc)$/u;

const cleanHost = (host) => String(host || "").trim().toLowerCase();

// The state with the mark of the name the connect starts on, when it is one
// of the site's names; on any other name (a Cloud Run address, a test
// server) the state stays as it was.
export function markStartHost(state, host) {
  const name = cleanHost(host);
  return SITE_HOSTS.has(name) && Object.hasOwn(MARKS, name) ? `${state}.at-${MARKS[name]}` : state;
}

// The name a marked state started on, or "".
export function startHostOf(state) {
  const match = MARK.exec(String(state || ""));
  return match ? HOSTS_BY_MARK[match[1]] : "";
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

// `path` is the callback's own path ("/api/google/callback"), `cookie` the
// name of the connect's state cookie. Everything else is left to the
// callback: a state this name's cookie holds, an unmarked state (a sign-in,
// or a connect from before this change), a request on another name.
export function returnToConnectStart({ path, cookie }) {
  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const state = typeof req.query?.state === "string" ? req.query.state : "";
    if (!state || cookieValue(req.headers?.cookie, cookie) === state) return next();
    const host = cleanHost(req.get("host"));
    if (!SITE_HOSTS.has(host)) return next();
    const start = startHostOf(state);
    if (!start || start === host) return next();
    const original = String(req.originalUrl || "");
    const query = original.includes("?") ? original.slice(original.indexOf("?")) : "";
    let location;
    try {
      location = new URL(`${path}${query}`, `https://${start}`);
    } catch {
      return next();
    }
    if (location.origin !== `https://${start}` || location.pathname !== path) return next();
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    return res.redirect(302, location.href);
  };
}
