import { createHash, randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";
import { resolveMemoryBackend } from "../config/memoryBackend.js";
import {
  CANONICAL_PROJECT_MEMORY_ID,
  PROJECT_DEFINITION,
  isSupersededProjectDefinition,
} from "../config/projectIdentity.js";
import { createFirestoreMemoryStore } from "./firestoreMemoryStore.js";

const PROFILE_INDEX = process.env.MEMORY_INDEX || "synchron-profile-memory-v1";
const CONVERSATION_INDEX =
  process.env.CONVERSATION_INDEX || "synchron-conversation-memory-v1";
const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user";
const MAX_MEMORIES = 200;
const MAX_CONVERSATION_MESSAGES = 20;
const MAX_CONVERSATIONS = 50;
const VALID_SCOPES = new Set(["personal", "project"]);
const indexPromises = new Map();
let firestoreStore = null;
let firestoreStoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreMemoryStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreStoreConfiguration = null;
}

export function profileMemoryDocumentId(ownerId, memoryKey) {
  const owner = String(ownerId || "").trim();
  const key = String(memoryKey || "").trim();
  if (!owner || !key) {
    throw new TypeError("Profile memory document ID requires owner and key.");
  }

  return `profile-${createHash("sha256")
    .update(owner)
    .update("\0")
    .update(key)
    .digest("hex")}`;
}

function getClientOrThrow() {
  const client = getOpenSearchClient();
  if (!client) {
    const error = new Error("OpenSearch не е конфигуриран.");
    error.code = "MEMORY_UNAVAILABLE";
    throw error;
  }
  return client;
}

function getMemoryBackendOrThrow() {
  const backend = resolveMemoryBackend(process.env);
  if (!backend) {
    const error = new Error("Невалиден MEMORY_BACKEND.");
    error.code = "MEMORY_UNAVAILABLE";
    throw error;
  }
  return backend;
}

function usesFirestoreMemory() {
  return getMemoryBackendOrThrow() === "firestore";
}

function getFirestoreStoreOrThrow() {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.GCLOUD_PROJECT,
    process.env.GCP_PROJECT_ID,
    process.env.FIRESTORE_DATABASE_ID,
    process.env.FIRESTORE_PROFILE_COLLECTION,
    process.env.FIRESTORE_CONVERSATION_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreStoreConfiguration !== configuration) {
    firestoreStore = createFirestoreMemoryStore({ env: process.env });
    firestoreStoreConfiguration = configuration;
  }
  return firestoreStore;
}

async function ensureIndex(index, mappings) {
  if (usesFirestoreMemory()) return;
  if (!indexPromises.has(index)) {
    const promise = (async () => {
      const client = getClientOrThrow();
      const existsResponse = await client.indices.exists({ index });
      const exists = existsResponse.body ?? existsResponse;

      if (!exists) {
        await client.indices.create({
          index,
          body: { mappings: { properties: mappings } },
        });
        return;
      }

      // Existing v1 indexes are upgraded in place. OpenSearch ignores fields
      // that already have the same mapping and adds the structured fields.
      await client.indices.putMapping({
        index,
        body: { properties: mappings },
      });
    })().catch((error) => {
      indexPromises.delete(index);
      throw error;
    });
    indexPromises.set(index, promise);
  }
  return indexPromises.get(index);
}

function ensureProfileIndex() {
  return ensureIndex(PROFILE_INDEX, {
    ownerId: { type: "keyword" },
    fact: { type: "text" },
    normalizedFact: { type: "keyword" },
    memoryKey: { type: "keyword" },
    category: { type: "keyword" },
    scope: { type: "keyword" },
    createdAt: { type: "date" },
    updatedAt: { type: "date" },
    source: { type: "keyword" },
  });
}

function ensureConversationIndex() {
  return ensureIndex(CONVERSATION_INDEX, {
    ownerId: { type: "keyword" },
    sessionId: { type: "keyword" },
    role: { type: "keyword" },
    content: { type: "text", index: false },
    createdAt: { type: "date" },
  });
}

function normalizeFact(fact) {
  return fact.trim().replace(/\s+/g, " ").toLocaleLowerCase("bg-BG");
}

function cleanMemoryFact(fact) {
  return fact
    .trim()
    .replace(/^[„“"'’]+|[„“"'’]+$/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:запомни|запази)\s+това[.!?]*$/iu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
}

export function normalizeProfileMemoryDraft(fact, requestedScope = "personal") {
  const cleanFact = typeof fact === "string" ? cleanMemoryFact(fact) : "";
  if (!cleanFact || cleanFact.length > 500) {
    const error = new Error(
      "Фактът за паметта трябва да бъде между 1 и 500 знака.",
    );
    error.code = "INVALID_MEMORY";
    throw error;
  }
  if (!VALID_SCOPES.has(requestedScope)) {
    const error = new Error("Невалиден тип памет.");
    error.code = "INVALID_MEMORY";
    throw error;
  }
  return Object.freeze({ fact: cleanFact, scope: requestedScope });
}

function splitMemoryFacts(value) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const lines = normalized
    .split(/\n+/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|(?:\d+)[.)])\s*/u, "").trim())
    .filter(Boolean);
  const candidates =
    lines.length > 1 ? lines : normalized.split(/\s*;\s*/u).filter(Boolean);

  return [...new Set(candidates.map(cleanMemoryFact).filter(Boolean))].slice(
    0,
    30,
  );
}

function normalizedWords(fact) {
  return normalizeFact(cleanMemoryFact(fact))
    .replace(/[„“"'’.,!?;:]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveMemoryMetadata(fact, requestedScope = "personal") {
  const normalized = normalizedWords(fact);
  const scope = VALID_SCOPES.has(requestedScope) ? requestedScope : "personal";

  if (scope === "project") {
    const projectName = normalized.match(
      /^(?:проектът|проекта|името на проекта)\s+(?:се казва|е)\s+/u,
    );
    if (projectName) {
      return {
        memoryKey: "project:identity:name",
        category: "identity",
        scope,
      };
    }
    if (/(?:целта|текущата цел|приоритетът) на проекта/u.test(normalized)) {
      return { memoryKey: "project:goal:current", category: "goal", scope };
    }
    if (
      /(?:инфраструктура|google\s*cloud|cloud\s*run|github|firestore)/u.test(
        normalized,
      )
    ) {
      return {
        memoryKey: `project:infrastructure:${normalized
          .replace(/\s+/g, "-")
          .slice(0, 80)}`,
        category: "infrastructure",
        scope,
      };
    }
    return {
      memoryKey: `project:fact:${normalized}`,
      category: "project-fact",
      scope,
    };
  }

  if (/^(?:казвам се|името ми е|аз съм)\s+/u.test(normalized)) {
    return { memoryKey: "personal:identity:name", category: "identity", scope };
  }
  if (
    /^(?:живея|местоживеенето ми е|градът ми е)\s+(?:във?|на)?\s*/u.test(
      normalized,
    )
  ) {
    return {
      memoryKey: "personal:location:residence",
      category: "location",
      scope,
    };
  }
  if (
    /^(?:любим(?:ият|ия)?\s+ми\s+цвят(?:ът)?|предпочитаният ми цвят)\s+(?:вече\s+)?е(?:\s|$)/u.test(
      normalized,
    )
  ) {
    return {
      memoryKey: "personal:preference:favorite-color",
      category: "preference",
      scope,
    };
  }
  const workHolding = normalized.match(
    /^(?:аз\s+)?имам\s+(?:бизнес\s+с\s+)?(фирма|магазин|заведение|бунгала|къмпинг)(.*)$/u,
  );
  if (workHolding) {
    return {
      memoryKey: `personal:work:${workHolding[1]}:${
        workHolding[2].trim().replace(/\s+/g, "-").slice(0, 80) || "general"
      }`,
      category: "work",
      scope,
    };
  }
  if (/^(?:аз\s+)?се\s+интересувам\s+от\s+/u.test(normalized)) {
    return {
      memoryKey: `personal:interest:${normalized
        .replace(/^(?:аз\s+)?се\s+интересувам\s+от\s+/u, "")
        .replace(/\s+/g, "-")
        .slice(0, 100)}`,
      category: "interest",
      scope,
    };
  }

  // "моят/моята/моето/моите X е VALUE" — topic-based key (without the value) so
  // that saving a new value for the same topic correctly supersedes the old one.
  const myThing = normalized.match(
    /^(?:моят|моята|моето|моите)\s+(.{2,80}?)\s+(?:вече\s+)?е(?:\s|$)/u,
  );
  if (myThing) {
    return {
      memoryKey: `personal:property:моят-${myThing[1]
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80)}`,
      category: "personal-fact",
      scope,
    };
  }

  const personalProperty = normalized.match(
    /^(.{2,80}?\s+ми)\s+(?:вече\s+)?е(?:\s|$)/u,
  );
  if (personalProperty) {
    return {
      memoryKey: `personal:property:${personalProperty[1]}`,
      category: "personal-fact",
      scope,
    };
  }

  return {
    memoryKey: `personal:fact:${normalized}`,
    category: "personal-fact",
    scope,
  };
}

export function extractPersistentMemoryCommand(message) {
  const text = message.trim();
  const projectPatterns = [
    /^запомни\s+за\s+проекта\s*:\s*([\s\S]+)$/iu,
    /^запомни\s+за\s+проекта\s*,?\s+че\s+([\s\S]+)$/iu,
    /^поправка\s+за\s+проекта\s*:\s*([\s\S]+)$/iu,
  ];
  const personalPatterns = [
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*:\s*([\s\S]+)$/iu,
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*,?\s+че\s+([\s\S]+)$/iu,
    /^запази\s+в\s+постоянната\s+памет\s*:\s*([\s\S]+)$/iu,
    /^поправка\s*:\s*([\s\S]+?)(?:\s+(?:запомни|запази)\s+това[.!?]*)?$/iu,
  ];

  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "project" };
  }
  for (const pattern of personalPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "personal" };
  }
  return null;
}

export function extractPersistentMemoryCommands(message) {
  const text = message.trim();
  const embeddedCommand = text.match(
    /(?:^|[.!?]\s+)(?:накрая\s+)?(?:поискай\s+потвърждение\s+да\s+)?запомни(?:ш)?(?:\s+в\s+постоянната\s+ми\s+памет)?\s*:\s*[„“"'’]?([^„“"'’]+?)[„“"'’]?(?=\s+(?:преди\s+запис|не\s+записвай|не\s+променяй)|$)/iu,
  );
  if (embeddedCommand?.[1]) {
    const fact = cleanMemoryFact(embeddedCommand[1]);
    if (fact) return [{ fact, scope: "personal" }];
  }

  const bulkPatterns = [
    {
      scope: "project",
      pattern: /^запомни\s+(?:следното\s+)?за\s+проекта\s*:\s*([\s\S]+)$/iu,
    },
    {
      scope: "project",
      pattern: /^запомни\s+за\s+проекта\s+следното\s*:\s*([\s\S]+)$/iu,
    },
    {
      scope: "personal",
      pattern: /^запомни\s+следното\s+за\s+мен\s*:\s*([\s\S]+)$/iu,
    },
    {
      scope: "personal",
      pattern: /^запомни\s+за\s+мен\s+следното\s*:\s*([\s\S]+)$/iu,
    },
    {
      scope: "personal",
      pattern: /^запомни\s+следното\s*:\s*([\s\S]+)$/iu,
    },
  ];

  for (const { scope, pattern } of bulkPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return splitMemoryFacts(match[1]).map((fact) => ({ fact, scope }));
    }
  }

  const singleCommand = extractPersistentMemoryCommand(text);
  return singleCommand ? [singleCommand] : [];
}

export function extractForgetMemoryCommand(message) {
  const text = message.trim();
  const projectPatterns = [
    /^(?:забрави|изтрий)\s+за\s+проекта\s*:\s*(.+)$/iu,
    /^(?:забрави|изтрий)\s+за\s+проекта\s*,?\s+че\s+(.+)$/iu,
  ];
  const personalPatterns = [
    /^(?:забрави|изтрий)(?:\s+от\s+(?:постоянната\s+)?памет(?:та)?)?(?:\s+само)?(?:\s+(?:на\s+)?факта)?\s*,?\s+че\s+(.+)$/iu,
    /^(?:забрави|изтрий)(?:\s+от\s+(?:постоянната\s+)?памет(?:та)?)?(?:\s+само)?(?:\s+(?:на\s+)?факта)?\s*:\s*(.+)$/iu,
  ];

  for (const pattern of projectPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "project" };
  }
  for (const pattern of personalPatterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return { fact, scope: "personal" };
  }
  return null;
}

export function isForgetAllCommand(message) {
  return /^(?:забрави|изтрий)\s+(?:цялата|всичко\s+от)\s+постоянна(?:та)?\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

export function isConfirmedForgetAllCommand(message) {
  return /^потвърждавам\s+изтриването\s+на\s+цялата\s+постоянна\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

async function fetchProfileHits(ownerId = OWNER_ID) {
  if (usesFirestoreMemory()) {
    const documents = await getFirestoreStoreOrThrow().listProfileDocuments(
      ownerId,
      MAX_MEMORIES,
    );
    return documents
      .sort((a, b) =>
        String(b.data?.updatedAt || "").localeCompare(
          String(a.data?.updatedAt || ""),
        ),
      )
      .map((document) => ({ _id: document.id, _source: document.data }));
  }
  const response = await getClientOrThrow().search({
    index: PROFILE_INDEX,
    body: {
      size: MAX_MEMORIES,
      sort: [{ updatedAt: { order: "desc" } }],
      query: { term: { ownerId } },
      _source: [
        "fact",
        "normalizedFact",
        "memoryKey",
        "category",
        "scope",
        "createdAt",
        "updatedAt",
        "source",
      ],
    },
  });
  return response.body?.hits?.hits ?? response.hits?.hits ?? [];
}

function hydrateMemory(hit) {
  if (!hit?._source?.fact) return null;
  const inferred = deriveMemoryMetadata(
    hit._source.fact,
    hit._source.scope || "personal",
  );
  return {
    id: hit._id,
    ...hit._source,
    storedMemoryKey: hit._source.memoryKey || null,
    // Always infer with the current rules. This makes old value-included keys
    // compatible with the new topic keys without deleting or rebuilding the
    // production index.
    memoryKey: inferred.memoryKey,
    category: inferred.category,
    scope: hit._source.scope || inferred.scope,
  };
}

function expandLegacyMemory(memory) {
  const fact = cleanMemoryFact(memory.fact || "");
  if (!fact) return [];

  const bulletParts = fact
    .replace(/^\s*-\s*/u, "")
    .split(/\s+-\s+(?=[А-ЯA-Z])/u);
  const facts = bulletParts.flatMap((part) =>
    part.split(
      /\s+и\s+(?=(?:аз\s+)?(?:се\s+интересувам|живея|имам\s+(?:бизнес|фирма|магазин|заведение|бунгала|къмпинг)|казвам\s+се))/iu,
    ),
  );

  return facts
    .map(cleanMemoryFact)
    .filter(Boolean)
    .map((itemFact) => {
      const inferred = deriveMemoryMetadata(
        itemFact,
        memory.scope || "personal",
      );
      return {
        ...memory,
        fact: itemFact,
        normalizedFact: normalizeFact(itemFact),
        ...inferred,
      };
    });
}

export function consolidateMemoryView(memories) {
  const expanded = memories.flatMap(expandLegacyMemory);
  const seenKeys = new Set();
  const unique = [];

  for (const memory of expanded) {
    if (seenKeys.has(memory.memoryKey)) continue;
    seenKeys.add(memory.memoryKey);
    unique.push(memory);
  }

  const interestItems = unique.filter(
    (memory) => memory.category === "interest",
  );
  if (interestItems.length < 2) return unique;

  const seen = new Set();
  const interests = [];
  for (const memory of interestItems) {
    const value = cleanMemoryFact(memory.fact).replace(
      /^(?:аз\s+)?се\s+интересувам\s+от\s+/iu,
      "",
    );
    for (const item of value.split(/\s*(?:,|;|\s+и\s+)\s*/iu)) {
      const cleanItem = item.trim();
      const key = normalizeFact(cleanItem);
      if (!cleanItem || seen.has(key)) continue;
      seen.add(key);
      interests.push(cleanItem);
    }
  }

  const newestInterest = interestItems[0];
  const consolidated = {
    ...newestInterest,
    fact: `Интересувам се от ${interests.join(", ")}`,
    normalizedFact: normalizeFact(interests.join(", ")),
    memoryKey: "personal:interest:summary",
    category: "interest",
  };
  const firstInterestIndex = unique.findIndex(
    (memory) => memory.category === "interest",
  );

  return unique
    .filter((memory) => memory.category !== "interest")
    .toSpliced(firstInterestIndex, 0, consolidated);
}

export async function listProfileMemories(options = {}) {
  await ensureProfileIndex();
  const requestedScope = typeof options === "string" ? options : options?.scope;
  const ownerId = (typeof options === "object" && options?.ownerId) || OWNER_ID;
  const hits = await fetchProfileHits(ownerId);
  const seenKeys = new Set();
  const memories = [];

  for (const hit of hits) {
    const memory = hydrateMemory(hit);
    if (!memory) continue;
    if (requestedScope && memory.scope !== requestedScope) continue;
    if (seenKeys.has(memory.memoryKey)) continue;
    seenKeys.add(memory.memoryKey);
    memories.push(memory);
  }
  const consolidated = consolidateMemoryView(memories);
  if (requestedScope === "personal") return consolidated;

  const currentProjectMemories = consolidated.filter(
    (memory) =>
      memory.scope !== "project" ||
      (!isSupersededProjectDefinition(memory.fact) &&
        memory.memoryKey !== "project:identity:definition" &&
        normalizeFact(memory.fact) !== normalizeFact(PROJECT_DEFINITION)),
  );
  const canonicalProjectMemory = {
    id: CANONICAL_PROJECT_MEMORY_ID,
    fact: PROJECT_DEFINITION,
    normalizedFact: normalizeFact(PROJECT_DEFINITION),
    memoryKey: "project:identity:definition",
    category: "identity",
    scope: "project",
    source: "system-canonical",
    readOnly: true,
  };

  if (requestedScope === "project") {
    return [canonicalProjectMemory, ...currentProjectMemories];
  }

  const firstProjectIndex = currentProjectMemories.findIndex(
    (memory) => memory.scope === "project",
  );
  if (firstProjectIndex < 0) {
    return [...currentProjectMemories, canonicalProjectMemory];
  }
  return currentProjectMemories.toSpliced(
    firstProjectIndex,
    0,
    canonicalProjectMemory,
  );
}

export async function saveProfileMemory(
  fact,
  source = "explicit-chat-command",
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const { fact: cleanFact, scope } = normalizeProfileMemoryDraft(
    fact,
    requestedScope,
  );

  await ensureProfileIndex();
  const firestore = usesFirestoreMemory();
  const client = firestore ? null : getClientOrThrow();
  const normalizedFact = normalizeFact(cleanFact);
  const metadata = deriveMemoryMetadata(cleanFact, scope);
  const hits = await fetchProfileHits(ownerId);
  const hydrated = hits.map(hydrateMemory).filter(Boolean);
  const sameTopic = hydrated.filter(
    (memory) => memory.memoryKey === metadata.memoryKey,
  );
  const exact = sameTopic.find(
    (memory) =>
      (memory.normalizedFact || normalizeFact(memory.fact)) === normalizedFact,
  );
  const existing = exact || sameTopic[0];
  const id = profileMemoryDocumentId(ownerId, metadata.memoryKey);
  const now = new Date().toISOString();

  const duplicateIds = sameTopic
    .filter((memory) => memory.id !== id)
    .map((memory) => memory.id);

  const document = {
    ownerId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };

  if (firestore) {
    await getFirestoreStoreOrThrow().commitProfileDocument({
      id,
      data: document,
      deleteIds: duplicateIds,
    });
  } else {
    await client.index({
      index: PROFILE_INDEX,
      id,
      refresh: true,
      body: document,
    });
  }

  let cleanupCompleted = true;
  if (!firestore && duplicateIds.length) {
    try {
      const cleanupResponse = await client.bulk({
        refresh: true,
        body: duplicateIds.map((duplicateId) => ({
          delete: { _index: PROFILE_INDEX, _id: duplicateId },
        })),
      });
      const cleanupResult = cleanupResponse?.body || cleanupResponse;
      if (cleanupResult?.errors) {
        throw new Error("Legacy duplicate cleanup was only partially applied.");
      }
    } catch {
      cleanupCompleted = false;
      console.error("[Memory] Legacy duplicate cleanup failed after save.");
    }
  }

  return {
    id,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    updatedAt: now,
    source,
    cleanupCompleted,
    replaced: Boolean(
      existing &&
      (existing.normalizedFact || normalizeFact(existing.fact)) !==
        normalizedFact,
    ),
  };
}

export async function updateProfileMemoryById(
  id,
  fact,
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const cleanId = typeof id === "string" ? id.trim() : "";
  if (!cleanId || cleanId.length > 200) {
    const error = new Error("Невалиден идентификатор на спомен.");
    error.code = "INVALID_MEMORY";
    throw error;
  }
  const { fact: cleanFact, scope } = normalizeProfileMemoryDraft(
    fact,
    requestedScope,
  );
  await ensureProfileIndex();
  let existing;
  if (usesFirestoreMemory()) {
    existing = (await getFirestoreStoreOrThrow().getProfileDocument(cleanId))
      ?.data;
    if (!existing) {
      const missing = new Error("Споменът не е намерен.");
      missing.code = "MEMORY_NOT_FOUND";
      missing.status = 404;
      throw missing;
    }
  } else {
    const client = getClientOrThrow();
    try {
      const response = await client.get({ index: PROFILE_INDEX, id: cleanId });
      existing = response.body?._source ?? response._source;
    } catch (error) {
      const status = error?.statusCode || error?.meta?.statusCode;
      if (status === 404) {
        const missing = new Error("Споменът не е намерен.");
        missing.code = "MEMORY_NOT_FOUND";
        missing.status = 404;
        throw missing;
      }
      throw error;
    }
  }
  if (existing?.ownerId !== ownerId) {
    const missing = new Error("Споменът не е намерен.");
    missing.code = "MEMORY_NOT_FOUND";
    missing.status = 404;
    throw missing;
  }

  const normalizedFact = normalizeFact(cleanFact);
  const metadata = deriveMemoryMetadata(cleanFact, scope);
  const nextId = profileMemoryDocumentId(ownerId, metadata.memoryKey);
  const now = new Date().toISOString();
  const body = {
    ownerId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    source: "confirmed-memory-update",
  };
  if (usesFirestoreMemory()) {
    await getFirestoreStoreOrThrow().commitProfileDocument({
      id: nextId,
      data: body,
      deleteIds: nextId === cleanId ? [] : [cleanId],
    });
  } else {
    const client = getClientOrThrow();
    const operations = [
      { index: { _index: PROFILE_INDEX, _id: nextId } },
      body,
    ];
    if (nextId !== cleanId) {
      operations.push({ delete: { _index: PROFILE_INDEX, _id: cleanId } });
    }
    const response = await client.bulk({ refresh: true, body: operations });
    const result = response.body || response;
    if (result?.errors) {
      const error = new Error(
        "Промяната на спомена не можа да бъде завършена еднозначно.",
      );
      error.code = "MEMORY_UPDATE_UNCERTAIN";
      error.status = 502;
      throw error;
    }
  }
  return {
    id: nextId,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    updatedAt: now,
    source: body.source,
    replaced: true,
  };
}

export async function deleteProfileMemoryByFact(
  fact,
  requestedScope = "personal",
  ownerId = OWNER_ID,
) {
  const cleanFact = cleanMemoryFact(fact);
  if (!cleanFact) return 0;

  await ensureProfileIndex();
  const metadata = deriveMemoryMetadata(cleanFact, requestedScope);
  const normalizedFact = normalizeFact(cleanFact);
  const hits = await fetchProfileHits(ownerId);
  const matchingIds = hits
    .map(hydrateMemory)
    .filter(
      (memory) =>
        memory?.memoryKey === metadata.memoryKey &&
        (memory.normalizedFact || normalizeFact(memory.fact)) ===
          normalizedFact,
    )
    .map((memory) => memory.id);
  if (!matchingIds.length) return 0;

  if (usesFirestoreMemory()) {
    await getFirestoreStoreOrThrow().deleteProfileDocuments(matchingIds);
    return matchingIds.length;
  }

  const response = await getClientOrThrow().deleteByQuery({
    index: PROFILE_INDEX,
    refresh: true,
    body: {
      query: {
        bool: {
          filter: [{ term: { ownerId } }, { terms: { _id: matchingIds } }],
        },
      },
    },
  });
  return response.body?.deleted ?? response.deleted ?? 0;
}

export async function deleteProfileMemory(id, ownerId = OWNER_ID) {
  await ensureProfileIndex();
  if (usesFirestoreMemory()) {
    const document = await getFirestoreStoreOrThrow().getProfileDocument(id);
    if (!document || document.data?.ownerId !== ownerId) return false;
    await getFirestoreStoreOrThrow().deleteProfileDocuments([id]);
    return true;
  }
  const response = await getClientOrThrow().deleteByQuery({
    index: PROFILE_INDEX,
    refresh: true,
    body: {
      query: {
        bool: {
          filter: [{ term: { ownerId } }, { term: { _id: id } }],
        },
      },
    },
  });
  return (response.body?.deleted ?? response.deleted ?? 0) > 0;
}

export async function clearProfileMemories(scope, ownerId = OWNER_ID) {
  await ensureProfileIndex();
  if (usesFirestoreMemory()) {
    const hits = await fetchProfileHits(ownerId);
    const ids = hits
      .filter((hit) => !VALID_SCOPES.has(scope) || hit._source?.scope === scope)
      .map((hit) => hit._id);
    if (!ids.length) return 0;
    await getFirestoreStoreOrThrow().deleteProfileDocuments(ids);
    return ids.length;
  }
  const filters = [{ term: { ownerId } }];
  if (VALID_SCOPES.has(scope)) filters.push({ term: { scope } });
  const response = await getClientOrThrow().deleteByQuery({
    index: PROFILE_INDEX,
    refresh: true,
    body: { query: { bool: { filter: filters } } },
  });
  return response.body?.deleted ?? response.deleted ?? 0;
}

export async function listConversationMessages(
  sessionId,
  limit = MAX_CONVERSATION_MESSAGES,
  ownerId = OWNER_ID,
) {
  await ensureConversationIndex();
  if (usesFirestoreMemory()) {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_CONVERSATION_MESSAGES);
    const documents =
      await getFirestoreStoreOrThrow().listConversationSessionDocuments(
        ownerId,
        sessionId,
        safeLimit,
      );
    return documents
      .sort((a, b) =>
        String(a.data?.createdAt || "").localeCompare(
          String(b.data?.createdAt || ""),
        ),
      )
      .slice(-safeLimit)
      .map((document) => ({ id: document.id, ...document.data }));
  }
  const response = await getClientOrThrow().search({
    index: CONVERSATION_INDEX,
    body: {
      size: Math.min(Math.max(limit, 1), MAX_CONVERSATION_MESSAGES),
      sort: [{ createdAt: { order: "desc" } }],
      query: {
        bool: {
          filter: [{ term: { ownerId } }, { term: { sessionId } }],
        },
      },
      _source: ["role", "content", "createdAt"],
    },
  });
  const hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
  return hits.map((hit) => ({ id: hit._id, ...hit._source })).reverse();
}

export function conversationTitleFromMessages(messages) {
  const firstUserMessage = messages.find(
    (message) =>
      message?.role === "user" && typeof message.content === "string",
  );
  const title = firstUserMessage?.content?.trim().replace(/\s+/g, " ");
  if (!title) return "Нов разговор";
  return title.length > 52 ? `${title.slice(0, 49).trimEnd()}…` : title;
}

export async function listConversationSummaries(
  limit = MAX_CONVERSATIONS,
  ownerId = OWNER_ID,
) {
  await ensureConversationIndex();
  if (usesFirestoreMemory()) {
    const documents =
      await getFirestoreStoreOrThrow().listConversationDocuments(ownerId);
    const grouped = new Map();
    for (const document of documents) {
      const sessionId = document.data?.sessionId;
      if (!sessionId) continue;
      if (!grouped.has(sessionId)) grouped.set(sessionId, []);
      grouped.get(sessionId).push(document.data);
    }
    return [...grouped.entries()]
      .map(([sessionId, messages]) => {
        messages.sort((a, b) =>
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
        );
        return {
          sessionId,
          title: conversationTitleFromMessages(messages),
          updatedAt: messages.at(-1)?.createdAt || null,
          messageCount: messages.length,
        };
      })
      .sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      )
      .slice(0, Math.min(Math.max(limit, 1), MAX_CONVERSATIONS));
  }
  const response = await getClientOrThrow().search({
    index: CONVERSATION_INDEX,
    body: {
      size: 0,
      query: { term: { ownerId } },
      aggs: {
        conversations: {
          terms: {
            field: "sessionId",
            size: Math.min(Math.max(limit, 1), MAX_CONVERSATIONS),
            order: { last_message: "desc" },
          },
          aggs: {
            last_message: { max: { field: "createdAt" } },
            messages: {
              top_hits: {
                size: MAX_CONVERSATION_MESSAGES,
                sort: [{ createdAt: { order: "asc" } }],
                _source: ["role", "content", "createdAt"],
              },
            },
          },
        },
      },
    },
  });
  const buckets =
    response.body?.aggregations?.conversations?.buckets ??
    response.aggregations?.conversations?.buckets ??
    [];

  return buckets.map((bucket) => {
    const hits = bucket.messages?.hits?.hits ?? [];
    const messages = hits.map((hit) => hit._source);
    return {
      sessionId: bucket.key,
      title: conversationTitleFromMessages(messages),
      updatedAt:
        bucket.last_message?.value_as_string ??
        messages.at(-1)?.createdAt ??
        null,
      messageCount: bucket.doc_count ?? messages.length,
    };
  });
}

export async function saveConversationTurn(
  sessionId,
  userText,
  replyText,
  ownerId = OWNER_ID,
) {
  await ensureConversationIndex();
  const timestamp = Date.now();
  const documents = [
    {
      id: randomUUID(),
      data: {
        ownerId,
        sessionId,
        role: "user",
        content: userText,
        createdAt: new Date(timestamp).toISOString(),
      },
    },
    {
      id: randomUUID(),
      data: {
        ownerId,
        sessionId,
        role: "assistant",
        content: replyText,
        createdAt: new Date(timestamp + 1).toISOString(),
      },
    },
  ];
  if (usesFirestoreMemory()) {
    await getFirestoreStoreOrThrow().commitConversationDocuments(documents);
    return;
  }
  const client = getClientOrThrow();
  const response = await client.bulk({
    refresh: true,
    body: [
      { index: { _index: CONVERSATION_INDEX, _id: documents[0].id } },
      documents[0].data,
      { index: { _index: CONVERSATION_INDEX, _id: documents[1].id } },
      documents[1].data,
    ],
  });
  const result = response.body || response;
  if (result?.errors) {
    const error = new Error(
      "Разговорът не можа да бъде записан изцяло в постоянната памет.",
    );
    error.code = "CONVERSATION_PERSISTENCE_FAILED";
    error.status = 502;
    throw error;
  }
}

export function buildMemoryContext(memories, { personName = "Радко" } = {}) {
  const personal = memories.filter(
    (memory) => (memory.scope || "personal") === "personal",
  );
  const storedProject = memories.filter(
    (memory) =>
      memory.scope === "project" && !isSupersededProjectDefinition(memory.fact),
  );
  const project = storedProject.some(
    (memory) =>
      normalizeFact(memory.fact) === normalizeFact(PROJECT_DEFINITION),
  )
    ? storedProject
    : [
        {
          id: CANONICAL_PROJECT_MEMORY_ID,
          fact: PROJECT_DEFINITION,
          scope: "project",
          readOnly: true,
        },
        ...storedProject,
      ];
  const format = (items, emptyText) =>
    items.length
      ? items.map((item, index) => `${index + 1}. ${item.fact}`).join("\n")
      : emptyText;

  return [
    "[ПРОВЕРЕНА ПОСТОЯННА ПАМЕТ]",
    `[ЛИЧЕН ПРОФИЛ НА ${personName.toLocaleUpperCase("bg-BG")}]`,
    `Тези факти описват ${personName} — човека. Те не описват теб.`,
    format(personal, "Няма допълнително записани лични факти."),
    "[КОНТЕКСТ НА ПРОЕКТА]",
    `Тези факти описват проекта, а не личността на ${personName}.`,
    format(project, "Няма допълнително записани проектни факти."),
    "Използвай само фактите, които са БУКВАЛНО свързани с текущия въпрос.",
    "При противоречие използвай най-новия показан факт (с по-нисък номер — той е по-нов).",
    "Не смесвай различни записи: 'тестова дума', 'тестов код', 'тестово число' и подобни са РАЗЛИЧНИ факти — не ги заменяй един с друг.",
    "Ако точен запис за зададения въпрос липсва в паметта, отговори честно: 'Не знам' — не измисляй и не предполагай стойност от друг несвързан запис.",
    "Не твърди, че помниш факт, ако не е показан тук или в историята на разговора.",
    "[КРАЙ НА ПАМЕТТА]",
  ].join("\n");
}
