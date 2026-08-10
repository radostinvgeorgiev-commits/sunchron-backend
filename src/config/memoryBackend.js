const MEMORY_BACKENDS = new Set(["opensearch", "firestore"]);

function resolveBackend(value, fallback = "opensearch") {
  const requested = String(value || fallback)
    .trim()
    .toLowerCase();
  return MEMORY_BACKENDS.has(requested) ? requested : null;
}

export function resolveMemoryBackend(env = process.env) {
  return resolveBackend(env.MEMORY_BACKEND);
}

export function resolvePersistenceBackend(env = process.env) {
  return resolveBackend(env.PERSISTENCE_BACKEND, resolveMemoryBackend(env));
}

export function resolveFirestoreProjectId(env = process.env) {
  return String(
    env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT_ID || "",
  ).trim();
}

export function resolveFirestoreDatabaseId(env = process.env) {
  return String(env.FIRESTORE_DATABASE_ID || "(default)").trim();
}

export function isOpenSearchMemoryConfigured(env = process.env) {
  return [
    "OPENSEARCH_HOST",
    "OPENSEARCH_PORT",
    "OPENSEARCH_USERNAME",
    "OPENSEARCH_PASSWORD",
  ].every((name) => Boolean(String(env[name] || "").trim()));
}

export function isFirestoreMemoryConfigured(env = process.env) {
  return (
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(resolveFirestoreProjectId(env)) &&
    /^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/u.test(
      resolveFirestoreDatabaseId(env),
    )
  );
}

export function isMemoryBackendConfigured(env = process.env) {
  const backend = resolveMemoryBackend(env);
  if (backend === "firestore") return isFirestoreMemoryConfigured(env);
  if (backend === "opensearch") return isOpenSearchMemoryConfigured(env);
  return false;
}

export function isPersistenceBackendConfigured(env = process.env) {
  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") return isFirestoreMemoryConfigured(env);
  if (backend === "opensearch") return isOpenSearchMemoryConfigured(env);
  return false;
}
