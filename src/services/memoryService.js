import { randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

const PROFILE_INDEX =
  process.env.MEMORY_INDEX || "synchron-profile-memory-v1";
const CONVERSATION_INDEX =
  process.env.CONVERSATION_INDEX || "synchron-conversation-memory-v1";
const OWNER_ID = process.env.MEMORY_OWNER_ID || "primary-user";
const MAX_MEMORIES = 200;
const MAX_CONVERSATION_MESSAGES = 20;
const MAX_CONVERSATIONS = 50;
const VALID_SCOPES = new Set(["personal", "project"]);
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

function splitMemoryFacts(value) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const lines = normalized
    .split(/\n+/u)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|(?:\d+)[.)])\s*/u, "")
        .trim(),
    )
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
  const scope = VALID_SCOPES.has(requestedScope)
    ? requestedScope
    : "personal";

  if (scope === "project") {
    const projectName = normalized.match(
      /^(?:проектът|проекта|името на проекта)\s+(?:се казва|е)\s+/u,
    );
    if (projectName) {
      return { memoryKey: "project:identity:name", category: "identity", scope };
    }
    if (/(?:целта|текущата цел|приоритетът) на проекта/u.test(normalized)) {
      return { memoryKey: "project:goal:current", category: "goal", scope };
    }
    if (/(?:инфраструктура|digitalocean|github|opensearch|cloudflare)/u.test(normalized)) {
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
      memoryKey: `personal:work:${workHolding[1]}:${workHolding[2]
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80) || "general"}`,
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

export function extractImplicitMemoryCandidates(message) {
  const text = cleanMemoryFact(message);
  if (
    !text ||
    text.length > 500 ||
    /[?？]$/u.test(message.trim()) ||
    extractPersistentMemoryCommands(message).length ||
    extractForgetMemoryCommand(message) ||
    isForgetAllCommand(message)
  ) {
    return [];
  }

  const clauses = text
    .split(
      /(?:[.!?]\s+|\s+и\s+(?=(?:аз\s+)?(?:се\s+интересувам|живея|имам\s+(?:бизнес|фирма|магазин|заведение|бунгала|къмпинг)|казвам\s+се)))/iu,
    )
    .map(cleanMemoryFact)
    .filter(Boolean);
  const stablePersonalFactPatterns = [
    /^(?:аз\s+)?казвам\s+се\s+.+$/iu,
    /^(?:аз\s+)?живея\s+(?:във?|на)\s+.+$/iu,
    /^(?:аз\s+)?се\s+интересувам\s+от\s+.+$/iu,
    /^(?:аз\s+)?имам\s+(?:бизнес|фирма|магазин|заведение|бунгала|къмпинг)(?:\s|$).*$/iu,
  ];

  return [
    ...new Set(
      clauses.filter((clause) =>
        stablePersonalFactPatterns.some((pattern) => pattern.test(clause)),
      ),
    ),
  ].map((fact) => ({ fact, scope: "personal", confidence: "high" }));
}

export function extractForgetMemoryCommand(message) {
  const text = message.trim();
  const projectPatterns = [
    /^(?:забрави|изтрий)\s+за\s+проекта\s*:\s*(.+)$/iu,
    /^(?:забрави|изтрий)\s+за\s+проекта\s*,?\s+че\s+(.+)$/iu,
  ];
  const personalPatterns = [
    /^(?:забрави|изтрий)(?:\s+от\s+паметта)?\s*,?\s+че\s+(.+)$/iu,
    /^(?:забрави|изтрий)(?:\s+от\s+паметта)?\s*:\s*(.+)$/iu,
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
    memoryKey: hit._source.memoryKey || inferred.memoryKey,
    category: hit._source.category || inferred.category,
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
  const requestedScope =
    typeof options === "string" ? options : options?.scope;
  const hits = await fetchProfileHits();
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
  return consolidateMemoryView(memories);
}

export async function saveProfileMemory(
  fact,
  source = "explicit-chat-command",
  requestedScope = "personal",
) {
  const cleanFact = cleanMemoryFact(fact);
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

  await ensureProfileIndex();
  const client = getClientOrThrow();
  const normalizedFact = normalizeFact(cleanFact);
  const metadata = deriveMemoryMetadata(cleanFact, requestedScope);
  const hits = await fetchProfileHits();
  const hydrated = hits.map(hydrateMemory).filter(Boolean);
  const sameTopic = hydrated.filter(
    (memory) => memory.memoryKey === metadata.memoryKey,
  );
  const exact = sameTopic.find(
    (memory) =>
      (memory.normalizedFact || normalizeFact(memory.fact)) === normalizedFact,
  );
  const existing = exact || sameTopic[0];
  const id = existing?.id || randomUUID();
  const now = new Date().toISOString();

  const duplicateIds = sameTopic
    .filter((memory) => memory.id !== id)
    .map((memory) => memory.id);
  if (duplicateIds.length) {
    await client.bulk({
      refresh: true,
      body: duplicateIds.map((duplicateId) => ({
        delete: { _index: PROFILE_INDEX, _id: duplicateId },
      })),
    });
  }

  await client.index({
    index: PROFILE_INDEX,
    id,
    refresh: true,
    body: {
      ownerId: OWNER_ID,
      fact: cleanFact,
      normalizedFact,
      ...metadata,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      source,
    },
  });
  return {
    id,
    fact: cleanFact,
    normalizedFact,
    ...metadata,
    updatedAt: now,
    source,
    replaced: Boolean(
      existing &&
        (existing.normalizedFact || normalizeFact(existing.fact)) !==
          normalizedFact,
    ),
  };
}

export async function deleteProfileMemoryByFact(
  fact,
  requestedScope = "personal",
) {
  const cleanFact = cleanMemoryFact(fact);
  if (!cleanFact) return 0;

  await ensureProfileIndex();
  const metadata = deriveMemoryMetadata(cleanFact, requestedScope);
  const hits = await fetchProfileHits();
  const matchingIds = hits
    .map(hydrateMemory)
    .filter((memory) => memory?.memoryKey === metadata.memoryKey)
    .map((memory) => memory.id);
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

export async function clearProfileMemories(scope) {
  await ensureProfileIndex();
  const filters = [{ term: { ownerId: OWNER_ID } }];
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

export function conversationTitleFromMessages(messages) {
  const firstUserMessage = messages.find(
    (message) =>
      message?.role === "user" && typeof message.content === "string",
  );
  const title = firstUserMessage?.content?.trim().replace(/\s+/g, " ");
  if (!title) return "Нов разговор";
  return title.length > 52 ? `${title.slice(0, 49).trimEnd()}…` : title;
}

export async function listConversationSummaries(limit = MAX_CONVERSATIONS) {
  await ensureConversationIndex();
  const response = await getClientOrThrow().search({
    index: CONVERSATION_INDEX,
    body: {
      size: 0,
      query: { term: { ownerId: OWNER_ID } },
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

export async function saveConversationTurn(sessionId, userText, replyText) {
  await ensureConversationIndex();
  const client = getClientOrThrow();
  const timestamp = Date.now();
  await client.bulk({
    refresh: true,
    body: [
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
    ],
  });
}

export function buildMemoryContext(memories) {
  const personal = memories.filter(
    (memory) => (memory.scope || "personal") === "personal",
  );
  const project = memories.filter((memory) => memory.scope === "project");
  const format = (items, emptyText) =>
    items.length
      ? items.map((item, index) => `${index + 1}. ${item.fact}`).join("\n")
      : emptyText;

  return [
    "[ПРОВЕРЕНА ПОСТОЯННА ПАМЕТ]",
    "[ЛИЧЕН ПРОФИЛ НА РАДКО]",
    "Тези факти описват Радко — човека. Те не описват теб.",
    format(personal, "Няма записани лични факти."),
    "[КОНТЕКСТ НА ПРОЕКТА]",
    "Тези факти описват проекта, а не личността на Радко.",
    format(project, "Няма записани проектни факти."),
    "Използвай само фактите, които са свързани с текущия въпрос.",
    "При противоречие използвай най-новия показан факт.",
    "Не измисляй липсващи факти и не твърди, че помниш нещо, което не е тук или в разговора.",
    "[КРАЙ НА ПАМЕТТА]",
  ].join("\n");
}
