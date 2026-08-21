import { createHash, randomUUID } from "node:crypto";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";
import { resolveFirestoreDatabaseId, resolveFirestoreProjectId } from "../config/memoryBackend.js";
import { normalizeKnowledgeCandidates } from "./knowledgeIngestionService.js";

const DEFAULT_COLLECTION = "synchron-knowledge-v1";
const MAX_CONTEXT_ITEMS = 40;
const MAX_CONTEXT_LENGTH = 12_000;

let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreKnowledgeStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}

function collectionName(env = process.env) {
  const value = String(env.FIRESTORE_KNOWLEDGE_COLLECTION || DEFAULT_COLLECTION).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    const error = new Error("Невалидна knowledge колекция.");
    error.code = "FIRESTORE_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  return value;
}

function getFirestoreStoreOrThrow(env = process.env) {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    resolveFirestoreProjectId(env),
    resolveFirestoreDatabaseId(env),
    collectionName(env),
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    firestoreStore = createFirestoreDocumentStore({ env });
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

function knowledgeId(ownerId, candidate) {
  const owner = String(ownerId || "").trim();
  if (!owner) throw new Error("Липсва собственик на знанието.");
  const fingerprint = createHash("sha256")
    .update(`${owner}\0${candidate.sourceId}\0${candidate.text.toLocaleLowerCase("bg-BG")}`)
    .digest("hex")
    .slice(0, 48);
  return `knowledge-${fingerprint}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function saveApprovedKnowledgeItems({
  ownerId,
  items,
  source = "archive-import-approved",
  store = getFirestoreStoreOrThrow(),
  now = nowIso,
} = {}) {
  const candidates = normalizeKnowledgeCandidates(items);
  const timestamp = now();
  const documents = candidates.map((candidate) => ({
    id: knowledgeId(ownerId, candidate),
    data: {
      ownerId,
      text: candidate.text,
      category: candidate.category,
      scope: candidate.scope,
      sourceId: candidate.sourceId,
      sourceTitle: candidate.sourceTitle,
      sourceType: candidate.sourceType,
      sourceCreatedAt: candidate.sourceCreatedAt || null,
      confidence: candidate.confidence,
      status: "approved",
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
      approvedAt: timestamp,
    },
  }));
  await store.commitOperations(
    documents.map(({ id, data }) => ({ type: "set", collection: collectionName(), id, data })),
  );
  return Object.freeze(
    documents.map(({ id, data }) => ({ id, ...data })),
  );
}

export async function listApprovedKnowledge({
  ownerId,
  scope,
  limit = MAX_CONTEXT_ITEMS,
  store = getFirestoreStoreOrThrow(),
} = {}) {
  const documents = await store.queryEqual(collectionName(), "ownerId", ownerId, 200);
  return documents
    .map((document) => ({ id: document.id, ...document.data }))
    .filter((item) => item.status === "approved")
    .filter((item) => !scope || item.scope === scope)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, Math.min(Math.max(Number(limit) || 1, 1), MAX_CONTEXT_ITEMS));
}

export function buildKnowledgeContext(items = []) {
  let remaining = MAX_CONTEXT_LENGTH;
  const approved = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status && item.status !== "approved") continue;
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text || remaining <= 0) continue;
    const line = `- [${item.category || "fact"}/${item.scope || "project"}] ${text} (източник: ${item.sourceTitle || item.sourceId || "архив"})`;
    if (line.length > remaining) break;
    approved.push(line);
    remaining -= line.length;
    if (approved.length >= MAX_CONTEXT_ITEMS) break;
  }
  if (!approved.length) return "";
  return [
    "[РАЗРЕШЕНО ЗНАНИЕ ОТ АРХИВА]",
    "Това са одобрени бележки от разговори и документи, не автоматично доказани факти.",
    "Използвай ги само ако са свързани с въпроса. При противоречие посочи източника и попитай Радко.",
    ...approved,
    "[КРАЙ НА АРХИВНОТО ЗНАНИЕ]",
  ].join("\n");
}

export function createInMemoryKnowledgeStore() {
  const documents = new Map();
  return {
    async queryEqual(_collection, field, value) {
      return [...documents.entries()]
        .filter(([, data]) => data?.[field] === value)
        .map(([id, data]) => ({ id, data }));
    },
    async commitOperations(operations) {
      for (const operation of operations) {
        if (operation.type === "set") documents.set(operation.id, { ...operation.data });
      }
    },
    async get(_collection, id) {
      const data = documents.get(id);
      return data ? { id, data } : null;
    },
    _documents: documents,
  };
}

export const KNOWLEDGE_CONFIG = Object.freeze({
  collection: DEFAULT_COLLECTION,
  maxContextItems: MAX_CONTEXT_ITEMS,
  maxContextLength: MAX_CONTEXT_LENGTH,
  generatedIdExample: () => `knowledge-${randomUUID()}`,
});
