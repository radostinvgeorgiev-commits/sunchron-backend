import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_PROFILE_COLLECTION = "synchron-profile-memory-v1";
const DEFAULT_CONVERSATION_COLLECTION = "synchron-conversation-memory-v1";

function cleanCollection(value, label) {
  const clean = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(clean)) {
    const error = new Error(`Невалиден ${label}.`);
    error.code = "FIRESTORE_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  return clean;
}

export function createFirestoreMemoryStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  documentStore,
} = {}) {
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl, now });
  const profileCollection = cleanCollection(
    env.FIRESTORE_PROFILE_COLLECTION || DEFAULT_PROFILE_COLLECTION,
    "Firestore profile collection",
  );
  const conversationCollection = cleanCollection(
    env.FIRESTORE_CONVERSATION_COLLECTION || DEFAULT_CONVERSATION_COLLECTION,
    "Firestore conversation collection",
  );

  return Object.freeze({
    backend: "firestore",
    async probe() {
      await store.queryEqual(
        profileCollection,
        "ownerId",
        "__synchron_health_monitor_no_user__",
        1,
      );
      return { status: "green", backend: "firestore" };
    },
    listProfileDocuments(ownerId, limit = 200) {
      return store.queryEqual(profileCollection, "ownerId", ownerId, limit);
    },
    listConversationDocuments(ownerId, limit = 1_000) {
      return store.query(conversationCollection, {
        filters: [{ field: "ownerId", value: ownerId }],
        limit,
        orderBy: { field: "createdAt", direction: "DESCENDING" },
      });
    },
    listConversationSessionDocuments(ownerId, sessionId, limit = 20) {
      return store.query(conversationCollection, {
        filters: [
          { field: "ownerId", value: ownerId },
          { field: "sessionId", value: sessionId },
        ],
        limit,
        orderBy: { field: "createdAt", direction: "DESCENDING" },
      });
    },
    getProfileDocument(id) {
      return store.get(profileCollection, id);
    },
    commitProfileDocument({ id, data, deleteIds = [] }) {
      return store.commitOperations([
        { type: "set", collection: profileCollection, id, data },
        ...deleteIds
          .filter((deleteId) => deleteId !== id)
          .map((deleteId) => ({
            type: "delete",
            collection: profileCollection,
            id: deleteId,
          })),
      ]);
    },
    deleteProfileDocuments(ids) {
      return store.commitOperations(
        ids.map((id) => ({
          type: "delete",
          collection: profileCollection,
          id,
        })),
      );
    },
    commitConversationDocuments(documents) {
      return store.commitOperations(
        documents.map(({ id, data }) => ({
          type: "set",
          collection: conversationCollection,
          id,
          data,
        })),
      );
    },
  });
}
