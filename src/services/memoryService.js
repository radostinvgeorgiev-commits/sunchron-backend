import { randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

const PROFILE_INDEX =
  process.env.MEMORY_INDEX || "synchron-profile-memory-v1";
const CONVERSATION_INDEX =
  process.env.CONVERSATION_INDEX || "synchron-conversation-memory-v1";
const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user";
const MAX_MEMORIES = 100;
const MAX_CONVERSATION_MESSAGES = 20;
const indexPromises = new Map();

function getClientOrThrow() {
  const client = getOpenSearchClient();
  if (!client) {
    const error = new Error("OpenSearch не е конфигуриран.");
    error.code = "MEMORY_UNAVAILABLE";
    throw error;
  }
  return client;
}

async function ensureIndex(index, mappings) {
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
      }
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

function deriveMemoryKey(fact) {
  const normalized = normalizeFact(cleanMemoryFact(fact))
    .replace(/[„“"'’.,!?;:]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(?:казвам се|името ми е)\s+/u.test(normalized)) {
    return "profile:name";
  }
  if (/^живея\s+(?:във?|на)\s+/u.test(normalized)) {
    return "profile:residence";
  }
  if (/^любим(?:ият|ия)?\s+ми\s+цвят(?:ът)?\s+(?:вече\s+)?е\b/u.test(normalized)) {
    return "preference:favorite-color";
  }
  if (/^имам\s+бизнес\b/u.test(normalized)) {
    return "profile:business";
  }

  const personalProperty = normalized.match(
    /^(.{2,80}?\s+ми)\s+(?:вече\s+)?е\b/u,
  );
  if (personalProperty) return `property:${personalProperty[1]}`;

  return `fact:${normalized}`;
}

export function extractPersistentMemoryCommand(message) {
  const text = message.trim();
  const patterns = [
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*:\s*(.+)$/iu,
    /^запомни(?:\s+за\s+бъдещи\s+разговори)?\s*,?\s+че\s+(.+)$/iu,
    /^запази\s+в\s+постоянната\s+памет\s*:\s*(.+)$/iu,
    /^поправка\s*:\s*(.+?)(?:\s+(?:запомни|запази)\s+това[.!?]*)?$/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return fact;
  }
  return null;
}

export function extractForgetMemoryCommand(message) {
  const text = message.trim();
  const patterns = [
    /^(?:забрави|изтрий)(?:\s+от\s+паметта)?\s*,?\s+че\s+(.+)$/iu,
    /^(?:забрави|изтрий)(?:\s+от\s+паметта)?\s*:\s*(.+)$/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const fact = match?.[1] ? cleanMemoryFact(match[1]) : "";
    if (fact) return fact;
  }
  return null;
}

export function isForgetAllCommand(message) {
  return /^(?:забрави|изтрий)\s+(?:цялата|всичко\s+от)\s+постоянната\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

async function fetchProfileHits() {
  const response = await getClientOrThrow().search({
    index: PROFILE_INDEX,
    body: {
      size: MAX_MEMORIES,
      sort: [{ updatedAt: { order: "desc" } }],
      query: { term: { ownerId: OWNER_ID } },
      _source: [
        "fact",
        "normalizedFact",
        "createdAt",
        "updatedAt",
        "source",
      ],
    },
  });
  return response.body?.hits?.hits ?? response.hits?.hits ?? [];
}

export async function listProfileMemories() {
  await ensureProfileIndex();
  const hits = await fetchProfileHits();
  const seenKeys = new Set();
  const memories = [];

  for (const hit of hits) {
    if (!hit._source?.fact) continue;
    const key = deriveMemoryKey(hit._source.fact);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    memories.push({ id: hit._id, ...hit._source });
  }
  return memories;
}

export async function saveProfileMemory(
  fact,
  source = "explicit-chat-command",
) {
  const cleanFact = cleanMemoryFact(fact);
  if (!cleanFact || cleanFact.length > 500) {
    const error = new Error(
      "Фактът за паметта трябва да бъде между 1 и 500 знака.",
    );
    error.code = "INVALID_MEMORY";
    throw error;
  }

  await ensureProfileIndex();
  const client = getClientOrThrow();
  const normalizedFact = normalizeFact(cleanFact);
  const memoryKey = deriveMemoryKey(cleanFact);
  const hits = await fetchProfileHits();
  const sameTopic = hits.filter(
    (hit) =>
      hit._source?.fact && deriveMemoryKey(hit._source.fact) === memoryKey,
  );
  const exact =
    sameTopic.find(
      (hit) =>
        (hit._source.normalizedFact || normalizeFact(hit._source.fact)) ===
        normalizedFact,
    ) ||
    hits.find(
      (hit) =>
        hit._source?.fact &&
        (hit._source.normalizedFact || normalizeFact(hit._source.fact)) ===
          normalizedFact,
    );
  const existing = exact || sameTopic[0];
  const id = existing?._id || randomUUID();
  const now = new Date().toISOString();

  const duplicateIds = sameTopic
    .filter((hit) => hit._id !== id)
    .map((hit) => hit._id);
  if (duplicateIds.length) {
    const operations = duplicateIds.flatMap((duplicateId) => [
      { delete: { _index: PROFILE_INDEX, _id: duplicateId } },
    ]);
    await client.bulk({ refresh: true, body: operations });
  }

  await client.index({
    index: PROFILE_INDEX,
    id,
    refresh: true,
    body: {
      ownerId: OWNER_ID,
      fact: cleanFact,
      normalizedFact,
      createdAt: existing?._source?.createdAt || now,
      updatedAt: now,
      source,
    },
  });
  return {
    id,
    fact: cleanFact,
    updatedAt: now,
    source,
    replaced: sameTopic.some(
      (hit) =>
        (hit._source.normalizedFact || normalizeFact(hit._source.fact)) !==
        normalizedFact,
    ),
  };
}

export async function deleteProfileMemoryByFact(fact) {
  const cleanFact = cleanMemoryFact(fact);
  if (!cleanFact) return 0;

  await ensureProfileIndex();
  const hits = await fetchProfileHits();
  const memoryKey = deriveMemoryKey(cleanFact);
  const matchingIds = hits
    .filter(
      (hit) =>
        hit._source?.fact && deriveMemoryKey(hit._source.fact) === memoryKey,
    )
    .map((hit) => hit._id);
  if (!matchingIds.length) return 0;

  const response = await getClientOrThrow().deleteByQuery({
    index: PROFILE_INDEX,
    refresh: true,
    body: {
      query: {
        bool: {
          filter: [
            { term: { ownerId: OWNER_ID } },
            { terms: { _id: matchingIds } },
          ],
        },
      },
    },
  });
  return response.body?.deleted ?? response.deleted ?? 0;
}

export async function deleteProfileMemory(id) {
  await ensureProfileIndex();
  const response = await getClientOrThrow().delete({
    index: PROFILE_INDEX,
    id,
    refresh: true,
  });
  return response.body?.result === "deleted" || response.result === "deleted";
}

export async function clearProfileMemories() {
  await ensureProfileIndex();
  const response = await getClientOrThrow().deleteByQuery({
    index: PROFILE_INDEX,
    refresh: true,
    body: { query: { term: { ownerId: OWNER_ID } } },
  });
  return response.body?.deleted ?? response.deleted ?? 0;
}

export async function listConversationMessages(
  sessionId,
  limit = MAX_CONVERSATION_MESSAGES,
) {
  await ensureConversationIndex();
  const response = await getClientOrThrow().search({
    index: CONVERSATION_INDEX,
    body: {
      size: Math.min(Math.max(limit, 1), MAX_CONVERSATION_MESSAGES),
      sort: [{ createdAt: { order: "desc" } }],
      query: {
        bool: {
          filter: [
            { term: { ownerId: OWNER_ID } },
            { term: { sessionId } },
          ],
        },
      },
      _source: ["role", "content", "createdAt"],
    },
  });
  const hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
  return hits
    .map((hit) => ({ id: hit._id, ...hit._source }))
    .reverse();
}

export async function saveConversationTurn(sessionId, userText, replyText) {
  await ensureConversationIndex();
  const client = getClientOrThrow();
  const timestamp = Date.now();
  const operations = [
    { index: { _index: CONVERSATION_INDEX, _id: randomUUID() } },
    {
      ownerId: OWNER_ID,
      sessionId,
      role: "user",
      content: userText,
      createdAt: new Date(timestamp).toISOString(),
    },
    { index: { _index: CONVERSATION_INDEX, _id: randomUUID() } },
    {
      ownerId: OWNER_ID,
      sessionId,
      role: "assistant",
      content: replyText,
      createdAt: new Date(timestamp + 1).toISOString(),
    },
  ];
  await client.bulk({ refresh: true, body: operations });
}

export function buildMemoryContext(memories) {
  const facts = memories.map((item, index) => `${index + 1}. ${item.fact}`);
  return [
    "[ПРОВЕРЕНА ПОСТОЯННА ПАМЕТ ЗА РАДКО]",
    "Тези факти описват Радко — човека. Те не описват теб.",
    facts.length ? facts.join("\n") : "Няма записани лични факти.",
    "При противоречие използвай най-новия показан факт.",
    "Не измисляй липсващи факти и не твърди, че помниш нещо, което не е тук или в разговора.",
    "[КРАЙ НА ПАМЕТТА]",
  ].join("\n");
}
