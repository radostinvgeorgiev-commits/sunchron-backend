import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_GRANT_COLLECTION = "synchron-mcp-oauth-grants-v1";
const DEFAULT_REPLAY_COLLECTION = "synchron-mcp-oauth-replay-v1";
const MAX_CONCURRENCY_ATTEMPTS = 3;
const MAX_QUERY_DOCUMENTS = 1_000;
const MAX_CLEANUP_DOCUMENTS = 500;

function configurationError(message, code = "MCP_OAUTH_STORAGE_UNAVAILABLE") {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

function collectionName(value, fallback, label) {
  const collection = String(value || fallback).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(collection)) {
    throw configurationError(`Невалидна Firestore ${label} collection.`);
  }
  return collection;
}

export function isFirestoreWriteConflict(error) {
  return (
    [409, 412].includes(Number(error?.upstreamStatus)) ||
    ["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(
      String(error?.upstreamErrorStatus || ""),
    )
  );
}

export function isFirestoreAlreadyExists(error) {
  return (
    Number(error?.upstreamStatus) === 409 ||
    String(error?.upstreamErrorStatus || "") === "ALREADY_EXISTS"
  );
}

export function createFirestoreMcpOAuthStore({
  env = process.env,
  documentStore,
  fetchImpl = globalThis.fetch,
} = {}) {
  const store =
    documentStore || createFirestoreDocumentStore({ env, fetchImpl });
  const grantCollection = collectionName(
    env.FIRESTORE_MCP_GRANT_COLLECTION,
    DEFAULT_GRANT_COLLECTION,
    "MCP grant",
  );
  const replayCollection = collectionName(
    env.FIRESTORE_MCP_REPLAY_COLLECTION,
    DEFAULT_REPLAY_COLLECTION,
    "MCP replay",
  );

  async function listGrantDocumentsBySubject(
    subject,
    limit = MAX_QUERY_DOCUMENTS,
  ) {
    return store.queryEqual(
      grantCollection,
      "subject",
      subject,
      Math.min(Math.max(Number(limit) || 1, 1), MAX_QUERY_DOCUMENTS),
      { includeMetadata: true },
    );
  }

  return Object.freeze({
    backend: "firestore",
    grantCollection,
    replayCollection,
    getGrant(id) {
      return store.get(grantCollection, id, { includeMetadata: true });
    },
    createGrant(id, data) {
      return store.set(grantCollection, id, data, { createOnly: true });
    },
    listGrantsBySubject(subject, limit = MAX_QUERY_DOCUMENTS) {
      return listGrantDocumentsBySubject(subject, limit);
    },
    async mutateGrant(id, mutate, maxAttempts = MAX_CONCURRENCY_ATTEMPTS) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const current = await store.get(grantCollection, id, {
          includeMetadata: true,
        });
        if (!current) return null;
        if (!current.updateTime) {
          throw configurationError(
            "Firestore MCP grant липсва version metadata.",
          );
        }
        const next = await mutate(structuredClone(current.data));
        if (!next) return { data: current.data, updated: false };
        try {
          await store.set(grantCollection, id, next, {
            updateTime: current.updateTime,
          });
          return { data: next, updated: true };
        } catch (error) {
          if (!isFirestoreWriteConflict(error)) throw error;
          if (attempt === maxAttempts) {
            throw configurationError(
              "Firestore MCP grant промяната е в конфликт.",
              "MCP_OAUTH_WRITE_CONFLICT",
            );
          }
        }
      }
      throw configurationError("Firestore MCP grant промяната не завърши.");
    },
    async revokeGrants({ subject, grantId = "", revokedAt }) {
      const updatedIds = new Set();
      for (let attempt = 1; attempt <= MAX_CONCURRENCY_ATTEMPTS; attempt += 1) {
        const documents = await listGrantDocumentsBySubject(subject);
        const targets = documents.filter(
          ({ id, data }) => !data.revokedAt && (!grantId || id === grantId),
        );
        if (targets.length === 0) return updatedIds.size;
        if (targets.some((document) => !document.updateTime)) {
          throw configurationError(
            "Firestore MCP revoke липсва version metadata.",
          );
        }
        try {
          await store.commitOperations(
            targets.map((document) => ({
              type: "set",
              collection: grantCollection,
              id: document.id,
              data: { ...document.data, revokedAt },
              updateTime: document.updateTime,
            })),
          );
          for (const document of targets) updatedIds.add(document.id);
        } catch (error) {
          if (!isFirestoreWriteConflict(error)) throw error;
        }
        if (attempt === MAX_CONCURRENCY_ATTEMPTS) {
          const remaining = (await listGrantDocumentsBySubject(subject)).some(
            ({ id, data }) => !data.revokedAt && (!grantId || id === grantId),
          );
          if (remaining) {
            throw configurationError(
              "Firestore MCP revoke не можа да бъде потвърден.",
              "MCP_OAUTH_WRITE_CONFLICT",
            );
          }
          return updatedIds.size;
        }
      }
      return updatedIds.size;
    },
    createReplay(id, data) {
      return store.set(
        replayCollection,
        id,
        {
          ...data,
          expiresAtEpoch: Number(data.expiresAtEpoch),
        },
        { createOnly: true },
      );
    },
    getReplay(id) {
      return store.get(replayCollection, id);
    },
    async cleanupExpiredReplay(nowEpoch, limit = MAX_CLEANUP_DOCUMENTS) {
      const documents = await store.query(replayCollection, {
        filters: [
          {
            field: "expiresAtEpoch",
            op: "LESS_THAN_OR_EQUAL",
            value: Number(nowEpoch),
          },
        ],
        limit: Math.min(Math.max(Number(limit) || 1, 1), MAX_CLEANUP_DOCUMENTS),
        includeMetadata: true,
      });
      if (documents.length === 0) return 0;
      if (documents.some((document) => !document.updateTime)) {
        throw configurationError(
          "Firestore MCP replay cleanup липсва version metadata.",
        );
      }
      await store.commitOperations(
        documents.map((document) => ({
          type: "delete",
          collection: replayCollection,
          id: document.id,
          updateTime: document.updateTime,
        })),
      );
      return documents.length;
    },
  });
}
