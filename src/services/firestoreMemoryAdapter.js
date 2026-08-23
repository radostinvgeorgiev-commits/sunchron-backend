import { createHash, randomUUID } from "node:crypto";

import {
  getFirestoreClient,
  getFirestoreConfigurationStatus,
  resolveFirestoreConfig,
} from "../config/firestore.js";
import {
  conversationMessageDocumentId,
  conversationSummaryDocumentId,
} from "../utils/memoryIdentifiers.js";
import { conversationTitleFromMessages } from "../utils/conversation.js";

export const FIRESTORE_SCHEMA_VERSION = 1;
export const FIRESTORE_MAX_MEMORIES = 200;
export const FIRESTORE_MAX_CONVERSATION_MESSAGES = 20;
export const FIRESTORE_MAX_CONVERSATIONS = 50;

const PROFILE_COLLECTION_SUFFIX = "profile-memories";
const MESSAGE_COLLECTION_SUFFIX = "conversation-messages";
const SUMMARY_COLLECTION_SUFFIX = "conversation-summaries";
const MAX_BATCH_WRITES = 450;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MEMORY_KEY_LENGTH = 600;
const MAX_INDEXED_MEMORY_KEY_BYTES = 1_200;

let cachedAdapter = null;
let cachedAdapterKey = null;
let cachedAdapterClient = null;
let testAdapterOverride = null;
let hasTestAdapterOverride = false;

function adapterError(message, code, options = {}) {
  const error = new Error(
    message,
    options.cause ? { cause: options.cause } : undefined,
  );
  error.code = code;
  if (options.status) error.status = options.status;
  return error;
}

function requiredOwner(ownerId) {
  const value = typeof ownerId === "string" ? ownerId.trim() : "";
  if (!value || value.length > 200) {
    throw adapterError(
      "Firestore memory operation requires an owner.",
      "FIRESTORE_INVALID_OWNER",
    );
  }
  return value;
}

function requiredSession(sessionId) {
  const value = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!value || value.length > 160 || /[\u0000-\u001f/]/u.test(value)) {
    throw adapterError(
      "Firestore conversation operation requires a valid session.",
      "FIRESTORE_INVALID_SESSION",
    );
  }
  return value;
}

function requiredDocumentId(id) {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value || value.length > 200 || /[\u0000-\u001f/]/u.test(value)) {
    throw adapterError(
      "Firestore memory operation requires a valid document.",
      "FIRESTORE_INVALID_DOCUMENT",
    );
  }
  return value;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw adapterError(
      `Firestore operation requires valid ${label}.`,
      "FIRESTORE_INVALID_INPUT",
    );
  }
  return value;
}

function dateValue(value, fallback = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (value && typeof value.toDate === "function") {
    const converted = value.toDate();
    if (converted instanceof Date && Number.isFinite(converted.getTime())) {
      return new Date(converted.getTime());
    }
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp);
  }
  return new Date(fallback.getTime());
}

function isoDate(value) {
  return dateValue(value).toISOString();
}

function snapshotData(snapshot) {
  if (!snapshot || snapshot.exists === false) return null;
  if (typeof snapshot.data === "function") {
    const data = snapshot.data();
    return data && typeof data === "object" ? data : null;
  }
  if (snapshot.data && typeof snapshot.data === "object") return snapshot.data;
  return null;
}

function snapshotId(snapshot, fallback = null) {
  return typeof snapshot?.id === "string" && snapshot.id
    ? snapshot.id
    : fallback;
}

function queryDocuments(snapshot) {
  return Array.isArray(snapshot?.docs) ? snapshot.docs : [];
}

function boundedLimit(value, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), maximum)
    : maximum;
}

function collectionName(prefix, suffix) {
  return `${prefix}${suffix}`;
}

function ensureCollection(client, name) {
  if (!client || typeof client.collection !== "function") {
    throw adapterError(
      "Firestore client-ът няма collection API.",
      "FIRESTORE_CLIENT_INVALID",
    );
  }
  return client.collection(name);
}

function ensureBatch(client) {
  if (!client || typeof client.batch !== "function") {
    throw adapterError(
      "Firestore client-ът няма batch API.",
      "FIRESTORE_CLIENT_INVALID",
    );
  }
  return client.batch();
}

async function withTimeout(operation, timeoutMs, code) {
  let timer;
  const promise = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = adapterError(code, code);
      timeoutError.settlement = promise.then(
        () => undefined,
        () => undefined,
      );
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function profileDocument(memory, ownerId, now) {
  const id = requiredDocumentId(memory?.id);
  const fact = requiredText(memory?.fact, "fact", 500);
  const normalizedFact = requiredText(
    memory?.normalizedFact,
    "normalizedFact",
    500,
  );
  const memoryKey = boundedMemoryKey(memory?.memoryKey);
  const category = requiredText(memory?.category, "category", 80);
  const scope = memory?.scope === "project" ? "project" : "personal";
  const createdAt = dateValue(memory?.createdAt, now);
  const updatedAt = dateValue(memory?.updatedAt, now);
  const source =
    typeof memory?.source === "string" && memory.source.trim()
      ? memory.source.trim().slice(0, 120)
      : "shadow";

  return {
    id,
    data: {
      schemaVersion: FIRESTORE_SCHEMA_VERSION,
      ownerId,
      fact,
      normalizedFact,
      memoryKey,
      category,
      scope,
      createdAt,
      updatedAt,
      source,
    },
  };
}

function boundedMemoryKey(value) {
  const key = requiredText(value, "memoryKey", MAX_MEMORY_KEY_LENGTH);
  return Buffer.byteLength(key, "utf8") <= MAX_INDEXED_MEMORY_KEY_BYTES
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function publicProfile(id, data) {
  return {
    id,
    fact: data.fact,
    normalizedFact: data.normalizedFact,
    memoryKey: data.memoryKey,
    category: data.category,
    scope: data.scope || "personal",
    createdAt: isoDate(data.createdAt),
    updatedAt: isoDate(data.updatedAt),
    source: data.source || null,
  };
}

function messageDocument({
  ownerId,
  sessionId,
  turnId,
  role,
  sequence,
  turnSequence,
  content,
  createdAt,
}) {
  return {
    schemaVersion: FIRESTORE_SCHEMA_VERSION,
    ownerId,
    sessionId,
    turnId,
    role,
    sequence,
    turnSequence,
    content,
    createdAt,
  };
}

function ensureMessageCompatible(
  existing,
  { ownerId, sessionId, role, content },
) {
  if (!existing) return false;
  if (
    existing.ownerId !== ownerId ||
    existing.sessionId !== sessionId ||
    existing.role !== role ||
    existing.content !== content
  ) {
    throw adapterError(
      "Firestore conversation document conflicts with the requested owner or turn.",
      "FIRESTORE_CONVERSATION_CONFLICT",
    );
  }
  return true;
}

function summaryDocument({
  ownerId,
  sessionId,
  existing,
  userText,
  messageCount,
  lastMessageAt,
  updatedAt,
  turnSequence,
}) {
  if (
    existing &&
    (existing.ownerId !== ownerId || existing.sessionId !== sessionId)
  ) {
    throw adapterError(
      "Firestore conversation summary conflicts with the requested owner.",
      "FIRESTORE_CONVERSATION_CONFLICT",
    );
  }

  const currentCount = Number.isFinite(Number(existing?.messageCount))
    ? Math.max(0, Number(existing.messageCount))
    : 0;
  const currentTitle =
    typeof existing?.title === "string" && existing.title.trim()
      ? existing.title.trim()
      : conversationTitleFromMessages([{ role: "user", content: userText }]);
  const nextLastMessageAt = dateValue(lastMessageAt);
  const nextUpdatedAt = dateValue(updatedAt);
  const existingLastMessageAt = existing?.lastMessageAt
    ? dateValue(existing.lastMessageAt)
    : null;
  const existingUpdatedAt = existing?.updatedAt
    ? dateValue(existing.updatedAt)
    : null;
  const currentTurnSequence = Number.isSafeInteger(
    Number(existing?.lastTurnSequence),
  )
    ? Math.max(0, Number(existing.lastTurnSequence))
    : 0;

  return {
    schemaVersion: FIRESTORE_SCHEMA_VERSION,
    ownerId,
    sessionId,
    title: currentTitle,
    messageCount: currentCount + messageCount,
    lastTurnSequence: Math.max(currentTurnSequence, turnSequence),
    lastMessageAt:
      existingLastMessageAt &&
      existingLastMessageAt.getTime() > nextLastMessageAt.getTime()
        ? existingLastMessageAt
        : nextLastMessageAt,
    updatedAt:
      existingUpdatedAt &&
      existingUpdatedAt.getTime() > nextUpdatedAt.getTime()
        ? existingUpdatedAt
        : nextUpdatedAt,
  };
}

function publicMessage(id, data) {
  return {
    id,
    role: data.role,
    content: data.content,
    createdAt: isoDate(data.createdAt),
  };
}

function publicSummary(data) {
  return {
    sessionId: data.sessionId,
    title: data.title || "Нов разговор",
    updatedAt: isoDate(data.lastMessageAt || data.updatedAt),
    messageCount: Math.max(0, Number(data.messageCount) || 0),
  };
}

function adapterKey(config) {
  return [
    config.projectId,
    config.databaseId,
    config.collectionPrefix,
    config.emulatorHost || "",
    config.requestTimeoutMs,
  ].join("\0");
}

export function createFirestoreMemoryAdapter({
  client,
  config,
  now = () => new Date(),
  timeoutMs,
} = {}) {
  const resolvedConfig = config || resolveFirestoreConfig();
  if (!resolvedConfig.enabled) return null;
  const firestore = client || getFirestoreClient();
  if (!firestore) {
    throw adapterError(
      "Firestore е включен, но client-ът липсва.",
      "FIRESTORE_CLIENT_UNAVAILABLE",
    );
  }

  const boundedTimeout =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.min(Number(timeoutMs), 30_000)
      : resolvedConfig.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
  const collections = {
    profiles: collectionName(
      resolvedConfig.collectionPrefix,
      PROFILE_COLLECTION_SUFFIX,
    ),
    messages: collectionName(
      resolvedConfig.collectionPrefix,
      MESSAGE_COLLECTION_SUFFIX,
    ),
    summaries: collectionName(
      resolvedConfig.collectionPrefix,
      SUMMARY_COLLECTION_SUFFIX,
    ),
  };

  const call = (operation, code) =>
    withTimeout(operation, boundedTimeout, code);

  const adapter = {
    mode: "shadow",
    schemaVersion: FIRESTORE_SCHEMA_VERSION,
    collections: Object.freeze({ ...collections }),

    async listProfileMemories({ ownerId, scope, limit } = {}) {
      const owner = requiredOwner(ownerId);
      let query = ensureCollection(firestore, collections.profiles).where(
        "ownerId",
        "==",
        owner,
      );
      if (scope === "personal" || scope === "project") {
        query = query.where("scope", "==", scope);
      }
      const snapshot = await call(
        () =>
          query
            .orderBy("updatedAt", "desc")
            .limit(boundedLimit(limit, FIRESTORE_MAX_MEMORIES))
            .get(),
        "FIRESTORE_PROFILE_READ_FAILED",
      );
      return queryDocuments(snapshot)
        .map((document) => {
          const data = snapshotData(document);
          return data ? publicProfile(snapshotId(document), data) : null;
        })
        .filter(Boolean);
    },

    async upsertProfileMemory({ ownerId, memory } = {}) {
      const owner = requiredOwner(ownerId);
      const profile = profileDocument(memory, owner, now());
      const reference = ensureCollection(firestore, collections.profiles).doc(
        profile.id,
      );
      const existingSnapshot = await call(
        () => reference.get(),
        "FIRESTORE_PROFILE_READ_FAILED",
      );
      const existing = snapshotData(existingSnapshot);
      if (existing && existing.ownerId !== owner) {
        throw adapterError(
          "Firestore profile document belongs to another owner.",
          "FIRESTORE_OWNER_CONFLICT",
        );
      }

      const data = {
        ...profile.data,
        createdAt: existing?.createdAt
          ? dateValue(existing.createdAt, profile.data.createdAt)
          : profile.data.createdAt,
      };
      await call(() => reference.set(data), "FIRESTORE_PROFILE_WRITE_FAILED");
      return publicProfile(profile.id, data);
    },

    async updateProfileMemory({ ownerId, memory, previousId } = {}) {
      const owner = requiredOwner(ownerId);
      const profile = profileDocument(memory, owner, now());
      const previous = previousId ? requiredDocumentId(previousId) : profile.id;
      const collection = ensureCollection(firestore, collections.profiles);
      const targetReference = collection.doc(profile.id);
      const previousReference = collection.doc(previous);
      const [targetSnapshot, previousSnapshot] = await Promise.all([
        call(() => targetReference.get(), "FIRESTORE_PROFILE_READ_FAILED"),
        previous === profile.id
          ? Promise.resolve(null)
          : call(
              () => previousReference.get(),
              "FIRESTORE_PROFILE_READ_FAILED",
            ),
      ]);
      const target = snapshotData(targetSnapshot);
      const old = snapshotData(previousSnapshot);
      if (
        (target && target.ownerId !== owner) ||
        (old && old.ownerId !== owner)
      ) {
        throw adapterError(
          "Firestore profile document belongs to another owner.",
          "FIRESTORE_OWNER_CONFLICT",
        );
      }

      const data = {
        ...profile.data,
        createdAt: (target || old)?.createdAt
          ? dateValue((target || old).createdAt, profile.data.createdAt)
          : profile.data.createdAt,
      };
      const batch = ensureBatch(firestore);
      batch.set(targetReference, data);
      if (previous !== profile.id && old) batch.delete(previousReference);
      await call(() => batch.commit(), "FIRESTORE_PROFILE_WRITE_FAILED");
      return publicProfile(profile.id, data);
    },

    async deleteProfileMemoryById({ ownerId, id } = {}) {
      const owner = requiredOwner(ownerId);
      const reference = ensureCollection(firestore, collections.profiles).doc(
        requiredDocumentId(id),
      );
      const snapshot = await call(
        () => reference.get(),
        "FIRESTORE_PROFILE_READ_FAILED",
      );
      const data = snapshotData(snapshot);
      if (!data || data.ownerId !== owner) return false;
      const batch = ensureBatch(firestore);
      batch.delete(reference);
      await call(() => batch.commit(), "FIRESTORE_PROFILE_DELETE_FAILED");
      return true;
    },

    async deleteProfileMemoryByFact({
      ownerId,
      memoryKey,
      normalizedFact,
    } = {}) {
      const owner = requiredOwner(ownerId);
      const key = boundedMemoryKey(memoryKey);
      const fact = requiredText(normalizedFact, "normalizedFact", 500);
      const query = ensureCollection(firestore, collections.profiles)
        .where("ownerId", "==", owner)
        .where("memoryKey", "==", key)
        .where("normalizedFact", "==", fact);
      const snapshot = await call(
        () => query.get(),
        "FIRESTORE_PROFILE_READ_FAILED",
      );
      const documents = queryDocuments(snapshot);
      if (!documents.length) return 0;
      let deleted = 0;
      for (let start = 0; start < documents.length; start += MAX_BATCH_WRITES) {
        const batch = ensureBatch(firestore);
        for (const document of documents.slice(
          start,
          start + MAX_BATCH_WRITES,
        )) {
          const data = snapshotData(document);
          if (data?.ownerId !== owner) continue;
          batch.delete(document.ref);
          deleted += 1;
        }
        await call(() => batch.commit(), "FIRESTORE_PROFILE_DELETE_FAILED");
      }
      return deleted;
    },

    async clearProfileMemories({ ownerId, scope } = {}) {
      const owner = requiredOwner(ownerId);
      let query = ensureCollection(firestore, collections.profiles).where(
        "ownerId",
        "==",
        owner,
      );
      if (scope === "personal" || scope === "project") {
        query = query.where("scope", "==", scope);
      }
      const snapshot = await call(
        () => query.get(),
        "FIRESTORE_PROFILE_READ_FAILED",
      );
      const documents = queryDocuments(snapshot);
      let deleted = 0;
      for (let start = 0; start < documents.length; start += MAX_BATCH_WRITES) {
        const batch = ensureBatch(firestore);
        for (const document of documents.slice(
          start,
          start + MAX_BATCH_WRITES,
        )) {
          const data = snapshotData(document);
          if (data?.ownerId !== owner) continue;
          batch.delete(document.ref);
          deleted += 1;
        }
        await call(() => batch.commit(), "FIRESTORE_PROFILE_DELETE_FAILED");
      }
      return deleted;
    },

    async listConversationMessages({ sessionId, limit, ownerId } = {}) {
      const owner = requiredOwner(ownerId);
      const session = requiredSession(sessionId);
      const query = ensureCollection(firestore, collections.messages)
        .where("ownerId", "==", owner)
        .where("sessionId", "==", session);
      const snapshot = await call(
        () =>
          query
            .orderBy("turnSequence", "desc")
            .orderBy("sequence", "desc")
            .limit(boundedLimit(limit, FIRESTORE_MAX_CONVERSATION_MESSAGES))
            .get(),
        "FIRESTORE_CONVERSATION_READ_FAILED",
      );
      return queryDocuments(snapshot)
        .map((document) => {
          const data = snapshotData(document);
          return data ? publicMessage(snapshotId(document), data) : null;
        })
        .filter(Boolean)
        .reverse();
    },

    async listConversationSummaries({ ownerId, limit } = {}) {
      const owner = requiredOwner(ownerId);
      const query = ensureCollection(firestore, collections.summaries)
        .where("ownerId", "==", owner)
        .orderBy("updatedAt", "desc")
        .limit(boundedLimit(limit, FIRESTORE_MAX_CONVERSATIONS));
      const snapshot = await call(
        () => query.get(),
        "FIRESTORE_CONVERSATION_READ_FAILED",
      );
      return queryDocuments(snapshot)
        .map((document) => {
          const data = snapshotData(document);
          return data ? publicSummary(data) : null;
        })
        .filter(Boolean);
    },

    async saveConversationTurn({
      ownerId,
      sessionId,
      userText,
      replyText,
      turnId = randomUUID(),
      createdAt,
    } = {}) {
      const owner = requiredOwner(ownerId);
      const session = requiredSession(sessionId);
      const userContent = requiredText(userText, "user content", 6_000);
      const assistantContent = requiredText(
        replyText,
        "assistant content",
        6_000,
      );
      const turn = requiredDocumentId(turnId);
      if (typeof firestore.runTransaction !== "function") {
        throw adapterError(
          "Firestore client-ът няма transaction API.",
          "FIRESTORE_CLIENT_INVALID",
        );
      }

      const baseDate = dateValue(createdAt, now());
      const assistantDate = new Date(baseDate.getTime() + 1);
      const userReference = ensureCollection(
        firestore,
        collections.messages,
      ).doc(
        conversationMessageDocumentId(owner, session, turn, "user"),
      );
      const assistantReference = ensureCollection(
        firestore,
        collections.messages,
      ).doc(
        conversationMessageDocumentId(owner, session, turn, "assistant"),
      );
      const summaryReference = ensureCollection(
        firestore,
        collections.summaries,
      ).doc(conversationSummaryDocumentId(owner, session));

      await call(
        () =>
          firestore.runTransaction(async (transaction) => {
            const [summarySnapshot, userSnapshot, assistantSnapshot] =
              await Promise.all([
                transaction.get(summaryReference),
                transaction.get(userReference),
                transaction.get(assistantReference),
              ]);
            const summary = snapshotData(summarySnapshot);
            const existingUser = snapshotData(userSnapshot);
            const existingAssistant = snapshotData(assistantSnapshot);
            const userExists = ensureMessageCompatible(existingUser, {
              ownerId: owner,
              sessionId: session,
              role: "user",
              content: userContent,
            });
            const assistantExists = ensureMessageCompatible(existingAssistant, {
              ownerId: owner,
              sessionId: session,
              role: "assistant",
              content: assistantContent,
            });
            const existingTurnSequence = [
              existingUser?.turnSequence,
              existingAssistant?.turnSequence,
            ]
              .map((value) => Number(value))
              .find((value) => Number.isSafeInteger(value) && value > 0);
            const currentTurnSequence = Number.isSafeInteger(
              Number(summary?.lastTurnSequence),
            )
              ? Math.max(0, Number(summary.lastTurnSequence))
              : 0;
            const turnSequence =
              existingTurnSequence || currentTurnSequence + 1;

            if (!userExists) {
              transaction.set(
                userReference,
                messageDocument({
                  ownerId: owner,
                  sessionId: session,
                  turnId: turn,
                  role: "user",
                  sequence: 0,
                  turnSequence,
                  content: userContent,
                  createdAt: baseDate,
                }),
              );
            }
            if (!assistantExists) {
              transaction.set(
                assistantReference,
                messageDocument({
                  ownerId: owner,
                  sessionId: session,
                  turnId: turn,
                  role: "assistant",
                  sequence: 1,
                  turnSequence,
                  content: assistantContent,
                  createdAt: assistantDate,
                }),
              );
            }

            transaction.set(
              summaryReference,
              summaryDocument({
                ownerId: owner,
                sessionId: session,
                existing: summary,
                userText: userContent,
                messageCount: Number(!userExists) + Number(!assistantExists),
                turnSequence,
                lastMessageAt: assistantDate,
                updatedAt: assistantDate,
              }),
            );
          }),
        "FIRESTORE_CONVERSATION_WRITE_FAILED",
      );

      return {
        turnId: turn,
        messageIds: [
          conversationMessageDocumentId(owner, session, turn, "user"),
          conversationMessageDocumentId(owner, session, turn, "assistant"),
        ],
        summaryId: conversationSummaryDocumentId(owner, session),
      };
    },
  };

  return Object.freeze(adapter);
}

export function getFirestoreMemoryAdapter(env = process.env) {
  if (hasTestAdapterOverride) return testAdapterOverride;
  const config = resolveFirestoreConfig(env);
  if (!config.enabled) return null;
  const client = getFirestoreClient(env);
  const key = adapterKey(config);
  if (
    cachedAdapter &&
    cachedAdapterKey === key &&
    cachedAdapterClient === client
  ) {
    return cachedAdapter;
  }
  cachedAdapter = createFirestoreMemoryAdapter({ client, config });
  cachedAdapterKey = key;
  cachedAdapterClient = client;
  return cachedAdapter;
}

export function isFirestoreMemoryShadowConfigured(env = process.env) {
  if (hasTestAdapterOverride) return Boolean(testAdapterOverride);
  return getFirestoreConfigurationStatus(env).status === "configured";
}

export function getFirestoreMemoryStatus(env = process.env) {
  const status = getFirestoreConfigurationStatus(env);
  return Object.freeze({
    ...status,
    adapterInitialized:
      status.status === "configured" && Boolean(cachedAdapter),
    adapterMode: status.enabled ? "shadow" : "disabled",
  });
}

export function setFirestoreMemoryAdapterForTests(adapter) {
  testAdapterOverride = adapter;
  hasTestAdapterOverride = true;
}

export function resetFirestoreMemoryAdapterForTests() {
  testAdapterOverride = null;
  hasTestAdapterOverride = false;
  cachedAdapter = null;
  cachedAdapterKey = null;
  cachedAdapterClient = null;
}
