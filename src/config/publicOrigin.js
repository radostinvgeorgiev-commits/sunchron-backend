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
