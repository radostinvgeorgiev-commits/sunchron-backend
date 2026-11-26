// "firestore" is the only real store. "local" keeps data in the running
// process only; it is the default for development and tests without a
// Google Cloud project and is never chosen in production.
const MEMORY_BACKENDS = new Set(["firestore", "local"]);

function resolveBackend(value, fallback = "firestore") {
  const requested = String(value || fallback)
    .trim()
    .toLowerCase();
  return MEMORY_BACKENDS.has(requested) ? requested : null;
}

function isProductionRuntime(env = process.env) {
  return (
    String(env.NODE_ENV || "")
      .trim()
      .toLowerCase() === "production"
  );
}

export function resolveMemoryBackend(env = process.env) {
  const fallback =
    isProductionRuntime(env) || resolveFirestoreProjectId(env)
      ? "firestore"
      : "local";
  const backend = resolveBackend(env.MEMORY_BACKEND, fallback);
  // Production never runs on the in-process store.
  return backend === "local" && isProductionRuntime(env) ? null : backend;
}

export function resolvePersistenceBackend(env = process.env) {
  const backend = resolveBackend(
    env.PERSISTENCE_BACKEND,
    resolveMemoryBackend(env),
  );
  return backend === "local" && isProductionRuntime(env) ? null : backend;
}

export function resolveFirestoreProjectId(env = process.env) {
  return String(
    env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT_ID || "",
  ).trim();
}

export function resolveFirestoreDatabaseId(env = process.env) {
  return String(env.FIRESTORE_DATABASE_ID || "(default)").trim();
}

export function isFirestoreMemoryConfigured(env = process.env) {
  return (
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(resolveFirestoreProjectId(env)) &&
    /^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/u.test(
      resolveFirestoreDatabaseId(env),
    )
  );
}

// The local in-process store is never reported as configured storage.
export function isMemoryBackendConfigured(env = process.env) {
  return (
    resolveMemoryBackend(env) === "firestore" &&
    isFirestoreMemoryConfigured(env)
  );
}

export function isPersistenceBackendConfigured(env = process.env) {
  return (
    resolvePersistenceBackend(env) === "firestore" &&
    isFirestoreMemoryConfigured(env)
  );
}
