import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const SESSION_PROVIDERS = Object.freeze({
  github: Object.freeze({
    collectionEnv: "FIRESTORE_GITHUB_SESSION_COLLECTION",
    defaultCollection: "synchron-github-sessions-v1",
  }),
  google: Object.freeze({
    collectionEnv: "FIRESTORE_GOOGLE_SESSION_COLLECTION",
    defaultCollection: "synchron-google-sessions-v1",
  }),
});

function configurationError(message) {
  const error = new Error(message);
  error.code = "OAUTH_SESSION_STORAGE_UNAVAILABLE";
  error.status = 503;
  return error;
}

function resolveProvider(value) {
  const provider = String(value || "")
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(SESSION_PROVIDERS, provider)) {
    throw configurationError("Невалиден Firestore OAuth session provider.");
  }
  return provider;
}

function resolveCollection(env, provider) {
  const configuration = SESSION_PROVIDERS[provider];
  const collection = String(
    env[configuration.collectionEnv] || configuration.defaultCollection,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(collection)) {
    throw configurationError("Невалидна Firestore OAuth session collection.");
  }
  return collection;
}

function unwrapSession(document, provider) {
  if (!document?.data || document.data.firestoreProvider !== provider) {
    return null;
  }
  const { firestoreProvider: _provider, ...payload } = document.data;
  return { id: document.id, payload };
}

export function createFirestoreOAuthSessionStore({
  provider: providerValue,
  env = process.env,
  documentStore,
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = resolveProvider(providerValue);
  const collection = resolveCollection(env, provider);
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl });

  return Object.freeze({
    backend: "firestore",
    provider,
    collection,
    async get(id) {
      return (
        unwrapSession(await store.get(collection, id), provider)?.payload ||
        null
      );
    },
    set(id, payload) {
      return store.set(collection, id, {
        ...payload,
        firestoreProvider: provider,
      });
    },
    delete(id) {
      return store.delete(collection, id);
    },
    async listLatest(limit = 100) {
      const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 1_000);
      const documents = await store.query(collection, {
        filters: [{ field: "firestoreProvider", value: provider }],
        orderBy: { field: "updatedAt", direction: "DESCENDING" },
        limit: safeLimit,
      });
      return documents
        .map((document) => unwrapSession(document, provider))
        .filter(Boolean)
        .sort((left, right) =>
          String(right.payload.updatedAt || "").localeCompare(
            String(left.payload.updatedAt || ""),
          ),
        );
    },
  });
}
