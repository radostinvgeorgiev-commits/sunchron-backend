import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_COLLECTION = "synchron-workspaces-v1";

function collectionName(env) {
  const value = String(
    env.FIRESTORE_WORKSPACE_COLLECTION || DEFAULT_COLLECTION,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    const error = new Error("Невалидна Firestore workspace collection.");
    error.code = "WORKSPACE_STORAGE_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  return value;
}

export function createFirestoreWorkspaceStore({
  env = process.env,
  documentStore,
  fetchImpl = globalThis.fetch,
} = {}) {
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl });
  const collection = collectionName(env);
  return Object.freeze({
    backend: "firestore",
    get(id) {
      return store.get(collection, id);
    },
    set(id, data) {
      return store.set(collection, id, data);
    },
  });
}
