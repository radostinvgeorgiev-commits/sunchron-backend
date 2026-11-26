// Identity Platform is the only sign-in backend. The old Supabase backend was
// retired after the accounts moved (2026-11-26).
export function resolveAuthBackend(env = process.env) {
  const requested = String(env.AUTH_BACKEND || "identity-platform")
    .trim()
    .toLowerCase();
  return requested === "identity-platform" ? requested : null;
}

export function resolveIdentityPlatformProjectId(env = process.env) {
  return String(
    env.IDENTITY_PLATFORM_PROJECT_ID ||
      env.GOOGLE_CLOUD_PROJECT ||
      env.GCLOUD_PROJECT ||
      env.GCP_PROJECT_ID ||
      "",
  ).trim();
}

export function resolveIdentityPlatformApiKey(env = process.env) {
  return String(env.IDENTITY_PLATFORM_API_KEY || "").trim();
}

export function isIdentityPlatformConfigured(env = process.env) {
  return (
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(
      resolveIdentityPlatformProjectId(env),
    ) && /^[A-Za-z0-9_-]{20,200}$/u.test(resolveIdentityPlatformApiKey(env))
  );
}
