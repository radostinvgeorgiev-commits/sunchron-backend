import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_COLLECTION = "synchron-task-runs-v1";

function collectionName(env) {
  const value = String(
    env.FIRESTORE_TASK_RUN_COLLECTION || DEFAULT_COLLECTION,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    const error = new Error("Невалидна Firestore task-run collection.");
    error.code = "TASK_RUN_STORAGE_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  return value;
}

export function createFirestoreTaskRunStore({
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
    listByOwner(ownerHash, limit = 100) {
      return store.queryEqual(
        collection,
        "ownerHash",
        ownerHash,
        Math.min(Math.max(Number(limit) || 1, 1), 1_000),
      );
    },
  });
}
