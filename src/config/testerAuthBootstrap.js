// The Supabase URL and publishable key are public client configuration, not
// secrets. Private session and invite values are derived inside production and
// are never stored in this file.
export const TESTER_AUTH_BOOTSTRAP = Object.freeze({
  projectUrl: "https://ahrimuhroxjmtojmhrfl.supabase.co",
  publishableKey: "sb_publishable_loKxmAIkhJiNiGB4HLKX1A_u2WtD44N",
});

export function normalizeTesterAuthProjectUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function normalizeTesterAuthPublishableKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return key.startsWith("sb_publishable_") || key.split(".").length === 3
    ? key
    : "";
}

export function resolveTesterAuthConnection(env = process.env) {
  const runtimeProjectUrl = normalizeTesterAuthProjectUrl(env.SUPABASE_URL);
  const runtimePublishableKey = normalizeTesterAuthPublishableKey(
    env.SUPABASE_PUBLISHABLE_KEY,
  );
  const runtimeReady = Boolean(runtimeProjectUrl && runtimePublishableKey);
  return Object.freeze({
    projectUrl: runtimeReady
      ? runtimeProjectUrl
      : normalizeTesterAuthProjectUrl(TESTER_AUTH_BOOTSTRAP.projectUrl),
    publishableKey: runtimeReady
      ? runtimePublishableKey
      : normalizeTesterAuthPublishableKey(TESTER_AUTH_BOOTSTRAP.publishableKey),
    connectionSource: runtimeReady ? "runtime" : "public-bootstrap",
  });
}
