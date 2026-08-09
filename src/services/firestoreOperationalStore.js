import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_CONFIRMATION_COLLECTION = "synchron-confirmations-v1";
const DEFAULT_AUDIT_COLLECTION = "synchron-action-audit-v1";
const AUDIT_PARTITION = "synchron-audit";

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

export function createFirestoreOperationalStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  documentStore,
} = {}) {
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl, now });
  const confirmationCollection = cleanCollection(
    env.FIRESTORE_CONFIRMATION_COLLECTION || DEFAULT_CONFIRMATION_COLLECTION,
    "Firestore confirmation collection",
  );
  const auditCollection = cleanCollection(
    env.FIRESTORE_AUDIT_COLLECTION || DEFAULT_AUDIT_COLLECTION,
    "Firestore audit collection",
  );

  return Object.freeze({
    backend: "firestore",
    saveConfirmation(id, data) {
      return store.set(confirmationCollection, id, data);
    },
    getConfirmation(id) {
      return store.get(confirmationCollection, id);
    },
    async deleteConfirmation(id) {
      const existing = await store.get(confirmationCollection, id);
      if (!existing) return false;
      await store.delete(confirmationCollection, id, { mustExist: true });
      return true;
    },
    saveAuditEntry(id, data) {
      return store.set(auditCollection, id, {
        ...data,
        firestorePartition: AUDIT_PARTITION,
      });
    },
    async listAuditEntries(limit = 50) {
      const entries = await store.queryEqual(
        auditCollection,
        "firestorePartition",
        AUDIT_PARTITION,
        Math.min(Math.max(Number(limit) || 1, 1), 100),
        {
          orderBy: { field: "timestamp", direction: "DESCENDING" },
        },
      );
      return entries
        .map(({ data }) => {
          const { firestorePartition: _partition, ...entry } = data;
          return entry;
        })
        .sort((left, right) =>
          String(right.timestamp || "").localeCompare(
            String(left.timestamp || ""),
          ),
        )
        .slice(0, Math.min(Math.max(Number(limit) || 1, 1), 100));
    },
  });
}
