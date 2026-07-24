import { randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

const INDEX_NAME = process.env.MEMORY_INDEX || "synchron-profile-memory-v1";
const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user";
const MAX_MEMORIES = 100;
let indexReadyPromise = null;

function getClientOrThrow() {
  const client = getOpenSearchClient();
  if (!client) {
    const error = new Error("OpenSearch не е конфигуриран.");
    error.code = "MEMORY_UNAVAILABLE";
    throw error;
  }
  return client;
}

async function ensureMemoryIndex() {
  if (!indexReadyPromise) {
    indexReadyPromise = (async () => {
      const client = getClientOrThrow();
      const existsResponse = await client.indices.exists({ index: INDEX_NAME });
      const exists = existsResponse.body ?? existsResponse;

      if (!exists) {
        await client.indices.create({
          index: INDEX_NAME,
          body: {
            mappings: {
              properties: {
                ownerId: { type: "keyword" },
                fact: { type: "text" },
                normalizedFact: { type: "keyword" },
                createdAt: { type: "date" },
                updatedAt: { type: "date" },
                source: { type: "keyword" },
              },
            },
          },
        });
      }
    })().catch((error) => {
      indexReadyPromise = null;
      throw error;
    });
  }

  return indexReadyPromise;
}

function normalizeFact(fact) {
  return fact.trim().replace(/\s+/g, " ").toLocaleLowerCase("bg-BG");
}

export function extractPersistentMemoryCommand(message) {
  const text = message.trim();
  const patterns = [
    /^запомни\s+за\s+бъдещи\s+разговори\s*:\s*(.+)$/iu,
    /^запази\s+в\s+постоянната\s+памет\s*:\s*(.+)$/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return null;
}

export function isForgetAllCommand(message) {
  return /^(?:забрави|изтрий)\s+(?:цялата|всичко\s+от)\s+постоянната\s+(?:ми\s+)?памет[.!]?$/iu.test(
    message.trim(),
  );
}

export async function listProfileMemories() {
  await ensureMemoryIndex();
  const client = getClientOrThrow();
  const response = await client.search({
    index: INDEX_NAME,
    body: {
      size: MAX_MEMORIES,
      sort: [{ updatedAt: { order: "asc" } }],
      query: { term: { ownerId: OWNER_ID } },
      _source: ["fact", "createdAt", "updatedAt", "source"],
    },
  });

  const hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
  return hits.map((hit) => ({ id: hit._id, ...hit._source }));
}

export async function saveProfileMemory(fact, source = "explicit-chat-command") {
  const cleanFact = fact.trim().replace(/\s+/g, " ");
  if (!cleanFact || cleanFact.length > 500) {
    const error = new Error(
      "Фактът за паметта трябва да бъде между 1 и 500 знака.",
    );
    error.code = "INVALID_MEMORY";
    throw error;
  }

  await ensureMemoryIndex();
  const client = getClientOrThrow();
  const normalizedFact = normalizeFact(cleanFact);
  const existingResponse = await client.search({
    index: INDEX_NAME,
    body: {
      size: 1,
      query: {
        bool: {
          filter: [
            { term: { ownerId: OWNER_ID } },
            { term: { normalizedFact } },
          ],
        },
      },
    },
  });
  const existingHits =
    existingResponse.body?.hits?.hits ?? existingResponse.hits?.hits ?? [];
  const now = new Date().toISOString();
  const id = existingHits[0]?._id || randomUUID();
  const createdAt = existingHits[0]?._source?.createdAt || now;

  await client.index({
    index: INDEX_NAME,
    id,
    refresh: true,
    body: {
      ownerId: OWNER_ID,
      fact: cleanFact,
      normalizedFact,
      createdAt,
      updatedAt: now,
      source,
    },
  });

  return { id, fact: cleanFact, createdAt, updatedAt: now, source };
}

export async function deleteProfileMemory(id) {
  await ensureMemoryIndex();
  const client = getClientOrThrow();
  const response = await client.delete({
    index: INDEX_NAME,
    id,
    refresh: true,
  });
  return response.body?.result === "deleted" || response.result === "deleted";
}

export async function clearProfileMemories() {
  await ensureMemoryIndex();
  const client = getClientOrThrow();
  const response = await client.deleteByQuery({
    index: INDEX_NAME,
    refresh: true,
    body: { query: { term: { ownerId: OWNER_ID } } },
  });
  return response.body?.deleted ?? response.deleted ?? 0;
}

export function buildMemoryContext(memories) {
  if (!memories.length) return null;
  const facts = memories.map((item, index) => `${index + 1}. ${item.fact}`);

  return [
    "[ПОСТОЯННА ПАМЕТ ЗА ЧОВЕКА]",
    "Данните по-долу описват човека, с когото разговаряш — не описват теб.",
    "Не разменяй самоличността на човека и AI асистента.",
    ...facts,
    "[КРАЙ НА ПОСТОЯННАТА ПАМЕТ]",
  ].join("\n");
}
