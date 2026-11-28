// The site's public address. Google's sign-in and connect flows must start and
// end on the same address, because the state cookie belongs to one address.
// So the address follows the Google return address configured in Cloud Run:
// while that still points to the old address, everything stays there, and
// switching GOOGLE_REDIRECT_URI to novariumai.com moves sign-in, connect links
// and their callbacks together, with no window where they disagree.
export const CANONICAL_ORIGIN = "https://novariumai.com";

export function publicOrigin(env = process.env) {
  const explicit = String(env.PUBLIC_ORIGIN || "").trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  try {
    const redirect = String(env.GOOGLE_REDIRECT_URI || "").trim();
    if (redirect) return new URL(redirect).origin;
  } catch {
    // not a URL; fall through to the canonical address
  }
  return CANONICAL_ORIGIN;
}

export function googleConnectUrl(env = process.env) {
  return String(env.GOOGLE_CONNECT_URL || `${publicOrigin(env)}/api/google/connect`);
}

// The site's two names. A sign-in or a Google or GitHub connection that starts
// on one name and comes back to the other loses its state cookie (it belongs
// to one address), so these start addresses first move to the public one. A
// sign-in begun on novariumai.com while Google still returns to the old name,
// or on the old name after the move, works either way.
const SITE_HOSTS = new Set([
  "cloudaicore.com",
  "www.cloudaicore.com",
  "novariumai.com",
  "www.novariumai.com",
]);
const START_PATH = /^\/api\/(?:auth\/[a-z]+\/start|google\/connect|github\/connect)$/u;

export function startOnPublicOrigin(env = process.env) {
  return (req, res, next) => {
    if (req.method !== "GET" || !START_PATH.test(req.path)) return next();
    const host = String(req.get("host") || "").trim().toLowerCase();
    let target;
    try {
      target = new URL(publicOrigin(env));
    } catch {
      return next();
    }
    if (!SITE_HOSTS.has(host) || host === target.host) return next();
    return res.redirect(302, `${target.origin}${req.originalUrl}`);
  };
}
