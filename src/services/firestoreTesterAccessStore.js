import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_COLLECTION = "synchron-tester-access-v1";

export function createFirestoreTesterAccessStore({
  env = process.env,
  documentStore,
  fetchImpl = globalThis.fetch,
} = {}) {
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl });
  const collection = String(
    env.FIRESTORE_TESTER_ACCESS_COLLECTION || DEFAULT_COLLECTION,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(collection)) {
    const error = new Error("Невалидна Firestore tester access collection.");
    error.code = "TESTER_ACCESS_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
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
