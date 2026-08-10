import { createHash } from "node:crypto";

import {
  deriveMemoryMetadata,
  profileMemoryDocumentId,
} from "./memoryService.js";
import { workspaceDocumentId } from "./workspaceStateService.js";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_DOCUMENTS = 20_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const MAX_FIRESTORE_DOCUMENT_BYTES = 900 * 1024;
const MIGRATION_CONFIRM_PREFIX = "MIGRATE_OPENSEARCH_TO_FIRESTORE:";

const DATASET_DEFINITIONS = Object.freeze([
  [
    "profile-memory",
    "MEMORY_INDEX",
    "synchron-profile-memory-v1",
    "FIRESTORE_PROFILE_COLLECTION",
    "synchron-profile-memory-v1",
    "profile",
  ],
  [
    "conversation-memory",
    "CONVERSATION_INDEX",
    "synchron-conversation-memory-v1",
    "FIRESTORE_CONVERSATION_COLLECTION",
    "synchron-conversation-memory-v1",
    "conversation",
  ],
  [
    "confirmations",
    "CONFIRMATION_INDEX",
    "synchron-confirmations-v1",
    "FIRESTORE_CONFIRMATION_COLLECTION",
    "synchron-confirmations-v1",
    "pending-confirmation",
  ],
  [
    "audit",
    "AUDIT_INDEX",
    "synchron-action-audit",
    "FIRESTORE_AUDIT_COLLECTION",
    "synchron-action-audit-v1",
    "audit",
  ],
  [
    "tester-access",
    "TESTER_ACCESS_INDEX",
    "synchron-tester-access-v1",
    "FIRESTORE_TESTER_ACCESS_COLLECTION",
    "synchron-tester-access-v1",
    "tester-access",
  ],
  [
    "workspace",
    "WORKSPACE_STATE_INDEX",
    "synchron-workspaces-v1",
    "FIRESTORE_WORKSPACE_COLLECTION",
    "synchron-workspaces-v1",
    "workspace",
  ],
  [
    "tasks",
    "TASK_INDEX",
    "synchron-tasks-v1",
    "FIRESTORE_TASK_COLLECTION",
    "synchron-tasks-v1",
    "task",
  ],
  [
    "github-oauth",
    "GITHUB_SESSION_INDEX",
    "synchron-github-sessions-v1",
    "FIRESTORE_GITHUB_SESSION_COLLECTION",
    "synchron-github-sessions-v1",
    "github-oauth",
  ],
  [
    "google-oauth",
    "GOOGLE_SESSION_INDEX",
    "synchron-google-sessions-v1",
    "FIRESTORE_GOOGLE_SESSION_COLLECTION",
    "synchron-google-sessions-v1",
    "google-oauth",
  ],
  [
    "mcp-grants",
    "MCP_OAUTH_GRANT_INDEX",
    "synchron-mcp-oauth-grants-v1",
    "FIRESTORE_MCP_GRANT_COLLECTION",
    "synchron-mcp-oauth-grants-v1",
    "copy",
  ],
  [
    "mcp-replay",
    "MCP_OAUTH_REPLAY_INDEX",
    "synchron-mcp-oauth-replay-v1",
    "FIRESTORE_MCP_REPLAY_COLLECTION",
    "synchron-mcp-oauth-replay-v1",
    "mcp-replay",
  ],
]);

export class GcpDataMigrationError extends Error {
  constructor(message, code = "GCP_DATA_MIGRATION_FAILED") {
    super(message);
    this.name = "GcpDataMigrationError";
    this.code = code;
  }
}

function migrationError(message, code) {
  return new GcpDataMigrationError(message, code);
}

function cleanIdentifier(value, label, pattern) {
  const clean = String(value || "").trim();
  if (!pattern.test(clean)) {
    throw migrationError(
      `Невалиден ${label}.`,
      "GCP_DATA_MIGRATION_CONFIGURATION_INVALID",
    );
  }
  return clean;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

function responseBody(response) {
  return response?.body ?? response ?? {};
}

function statusCode(error) {
  return Number(
    error?.statusCode || error?.meta?.statusCode || error?.status || 0,
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function taskOwnerFingerprint(ownerId) {
  return createHash("sha256")
    .update("synchron-task-owner-v1\0")
    .update(ownerId)
    .digest("hex");
}

function cleanDocument(hit) {
  const id = cleanIdentifier(
    hit?._id,
    "OpenSearch document ID",
    /^[^/]{1,500}$/u,
  );
  const source = hit?._source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw migrationError(
      "OpenSearch документът няма валиден source object.",
      "GCP_DATA_MIGRATION_SOURCE_INVALID",
    );
  }
  return { id, data: structuredClone(source) };
}

export function resolveGcpMigrationDatasets(env = process.env) {
  return DATASET_DEFINITIONS.map(
    ([id, sourceEnv, sourceFallback, targetEnv, targetFallback, transform]) =>
      Object.freeze({
        id,
        sourceIndex: cleanIdentifier(
          env[sourceEnv] || sourceFallback,
          `${id} source index`,
          /^[A-Za-z0-9_.-]{1,255}$/u,
        ),
        targetCollection: cleanIdentifier(
          env[targetEnv] || targetFallback,
          `${id} target collection`,
          /^[A-Za-z0-9_-]{1,120}$/u,
        ),
        transform,
      }),
  );
}

export function normalizeMigrationIdentityMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError(
      "Identity migration map трябва да е JSON object.",
      "GCP_DATA_MIGRATION_IDENTITY_MAP_INVALID",
    );
  }
  const entries = Object.entries(value).map(([sourceId, targetId]) => [
    cleanIdentifier(sourceId, "Supabase user ID", /^[A-Za-z0-9:_-]{1,128}$/u),
    cleanIdentifier(
      targetId,
      "Identity Platform user ID",
      /^[A-Za-z0-9:_-]{1,128}$/u,
    ),
  ]);
  const targets = new Set(entries.map(([, targetId]) => targetId));
  if (targets.size !== entries.length) {
    throw migrationError(
      "Identity migration map съдържа дублиран target user ID.",
      "GCP_DATA_MIGRATION_IDENTITY_MAP_INVALID",
    );
  }
  return new Map(entries);
}

function migrationContext(identityMap) {
  const ownerIds = new Map();
  const workspaceIds = new Map();
  const taskOwnerHashes = new Map();
  for (const [sourceId, targetId] of identityMap) {
    const sourceOwner = `supabase:${sourceId}`;
    const targetOwner = `identity-platform:${targetId}`;
    ownerIds.set(sourceOwner, targetOwner);
    workspaceIds.set(
      workspaceDocumentId(sourceOwner),
      workspaceDocumentId(targetOwner),
    );
    taskOwnerHashes.set(
      taskOwnerFingerprint(sourceOwner),
      taskOwnerFingerprint(targetOwner),
    );
  }
  return { identityMap, ownerIds, workspaceIds, taskOwnerHashes };
}

function mappedOwnerId(ownerId, context) {
  const clean = String(ownerId || "").trim();
  if (!clean.startsWith("supabase:")) return clean;
  const mapped = context.ownerIds.get(clean);
  if (!mapped) {
    throw migrationError(
      "Липсва Identity Platform mapping за Supabase owner.",
      "GCP_DATA_MIGRATION_IDENTITY_MAPPING_REQUIRED",
    );
  }
  return mapped;
}

function transformedDocumentSize(data) {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > MAX_FIRESTORE_DOCUMENT_BYTES) {
    throw migrationError(
      "Документът надвишава безопасния Firestore размер.",
      "GCP_DATA_MIGRATION_DOCUMENT_TOO_LARGE",
    );
  }
  return bytes;
}

export function transformGcpMigrationDocument(
  dataset,
  hit,
  identityMapValue = new Map(),
) {
  const identityMap =
    identityMapValue instanceof Map
      ? identityMapValue
      : normalizeMigrationIdentityMap(identityMapValue);
  const context = migrationContext(identityMap);
  const { id, data } = cleanDocument(hit);
  let targetId = id;
  let targetData = data;
  let skipReason = null;

  switch (dataset.transform) {
    case "profile": {
      const ownerId = mappedOwnerId(data.ownerId, context);
      const storedMemoryKey = String(data.memoryKey || "").trim();
      const fact = String(data.fact || "").trim();
      const inferred =
        !storedMemoryKey && fact
          ? deriveMemoryMetadata(fact, data.scope || "personal")
          : null;
      const memoryKey = storedMemoryKey || inferred?.memoryKey || "";
      if (!ownerId || !memoryKey) {
        throw migrationError(
          "Profile memory документът няма ownerId/memoryKey.",
          "GCP_DATA_MIGRATION_SOURCE_INVALID",
        );
      }
      targetId = profileMemoryDocumentId(ownerId, memoryKey);
      targetData = {
        ...data,
        ownerId,
        ...(inferred
          ? {
              memoryKey: inferred.memoryKey,
              category: inferred.category,
              scope: inferred.scope,
            }
          : {}),
      };
      break;
    }
    case "conversation": {
      const ownerId = mappedOwnerId(data.ownerId, context);
      if (!ownerId) {
        throw migrationError(
          "Conversation документът няма ownerId.",
          "GCP_DATA_MIGRATION_SOURCE_INVALID",
        );
      }
      targetData = { ...data, ownerId };
      break;
    }
    case "pending-confirmation":
      skipReason = "pending-confirmations-are-session-bound";
      break;
    case "audit":
      targetData = { ...data, firestorePartition: "synchron-audit" };
      break;
    case "tester-access": {
      if (id.startsWith("email:")) {
        skipReason = "email-approval-hash-is-secret-bound";
        break;
      }
      if (data.authProvider === "identity-platform") break;
      const sourceUserId = String(data.userId || "").trim();
      const targetUserId = context.identityMap.get(sourceUserId);
      if (!targetUserId) {
        throw migrationError(
          "Липсва Identity Platform mapping за tester access user.",
          "GCP_DATA_MIGRATION_IDENTITY_MAPPING_REQUIRED",
        );
      }
      targetId = `identity-platform:${targetUserId}`;
      targetData = {
        ...data,
        userId: targetUserId,
        authProvider: "identity-platform",
      };
      break;
    }
    case "workspace": {
      const mappedId = context.workspaceIds.get(id);
      if (mappedId) {
        targetId = mappedId;
        targetData = { ...data, ownerHash: mappedId };
      }
      break;
    }
    case "task": {
      const ownerHash = String(data.ownerHash || "").trim();
      targetData = {
        ...data,
        ownerHash: context.taskOwnerHashes.get(ownerHash) || ownerHash,
      };
      break;
    }
    case "github-oauth":
      targetData = { ...data, firestoreProvider: "github" };
      break;
    case "google-oauth":
      targetData = { ...data, firestoreProvider: "google" };
      break;
    case "mcp-replay": {
      const directExpiry =
        data.expiresAtEpoch === undefined ||
        data.expiresAtEpoch === null ||
        data.expiresAtEpoch === ""
          ? NaN
          : Number(data.expiresAtEpoch);
      const legacyExpiry = Date.parse(String(data.expiresAt || ""));
      const expiresAtEpoch = Number.isFinite(directExpiry)
        ? Math.floor(directExpiry)
        : Math.floor(legacyExpiry / 1_000);
      if (!Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch <= 0) {
        throw migrationError(
          "MCP replay документът няма валиден expiresAtEpoch.",
          "GCP_DATA_MIGRATION_SOURCE_INVALID",
        );
      }
      targetData = { ...data, expiresAtEpoch };
      break;
    }
    case "copy":
      break;
    default:
      throw migrationError(
        "Непознат migration transform.",
        "GCP_DATA_MIGRATION_CONFIGURATION_INVALID",
      );
  }

  const bytes = skipReason ? 0 : transformedDocumentSize(targetData);
  return Object.freeze({
    sourceId: id,
    targetId,
    targetData: skipReason ? null : targetData,
    skipReason,
    bytes,
  });
}

async function indexExists(client, index) {
  if (!client?.indices?.exists) return true;
  try {
    return Boolean(responseBody(await client.indices.exists({ index })));
  } catch (error) {
    if (statusCode(error) === 404) return false;
    throw error;
  }
}

export async function createOpenSearchMigrationInventory({
  client,
  env = process.env,
  datasets = resolveGcpMigrationDatasets(env),
} = {}) {
  if (!client) {
    throw migrationError(
      "OpenSearch client не е конфигуриран.",
      "GCP_DATA_MIGRATION_SOURCE_UNAVAILABLE",
    );
  }
  const inventory = [];
  for (const dataset of datasets) {
    const exists = await indexExists(client, dataset.sourceIndex);
    let count = 0;
    if (exists) {
      const payload = responseBody(
        await client.count({ index: dataset.sourceIndex }),
      );
      count = Number(payload.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw migrationError(
          "OpenSearch count отговорът е невалиден.",
          "GCP_DATA_MIGRATION_SOURCE_INVALID",
        );
      }
    }
    inventory.push({
      id: dataset.id,
      sourceIndex: dataset.sourceIndex,
      targetCollection: dataset.targetCollection,
      exists,
      count,
    });
  }
  return Object.freeze({
    mode: "inventory",
    totalDocuments: inventory.reduce((sum, item) => sum + item.count, 0),
    datasets: inventory,
  });
}

async function scanDataset({
  client,
  dataset,
  identityMap,
  pageSize,
  collect,
  maxDocuments,
  maxBytes,
}) {
  if (!(await indexExists(client, dataset.sourceIndex))) {
    return {
      id: dataset.id,
      sourceIndex: dataset.sourceIndex,
      targetCollection: dataset.targetCollection,
      exists: false,
      sourceCount: 0,
      writableCount: 0,
      skippedCount: 0,
      skippedReasons: {},
      bytes: 0,
      fingerprint: sha256(`${dataset.id}\0missing`),
      documents: [],
    };
  }

  const hash = createHash("sha256").update(`${dataset.id}\0`);
  const documents = [];
  const skippedReasons = {};
  let sourceCount = 0;
  let writableCount = 0;
  let skippedCount = 0;
  let bytes = 0;
  let scrollId = "";
  let response = await client.search({
    index: dataset.sourceIndex,
    scroll: "2m",
    size: pageSize,
    body: { query: { match_all: {} }, sort: ["_doc"] },
  });
  try {
    while (true) {
      const payload = responseBody(response);
      scrollId = String(payload._scroll_id || scrollId || "");
      const hits = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];
      if (hits.length === 0) break;
      for (const hit of hits) {
        sourceCount += 1;
        if (sourceCount > maxDocuments) {
          throw migrationError(
            "Migration документите надвишават безопасния лимит.",
            "GCP_DATA_MIGRATION_LIMIT_EXCEEDED",
          );
        }
        const transformed = transformGcpMigrationDocument(
          dataset,
          hit,
          identityMap,
        );
        if (transformed.skipReason) {
          skippedCount += 1;
          skippedReasons[transformed.skipReason] =
            (skippedReasons[transformed.skipReason] || 0) + 1;
          hash.update(
            `skip\0${transformed.sourceId}\0${transformed.skipReason}\0`,
          );
          continue;
        }
        writableCount += 1;
        bytes += transformed.bytes;
        if (bytes > maxBytes) {
          throw migrationError(
            "Migration payload надвишава безопасния memory лимит.",
            "GCP_DATA_MIGRATION_LIMIT_EXCEEDED",
          );
        }
        hash.update(
          `${transformed.targetId}\0${stableJson(transformed.targetData)}\0`,
        );
        if (collect) documents.push(transformed);
      }
      if (!scrollId || hits.length < pageSize) break;
      response = await client.scroll({
        scroll: "2m",
        body: { scroll_id: scrollId },
      });
    }
  } finally {
    if (scrollId && client.clearScroll) {
      await client
        .clearScroll({ body: { scroll_id: scrollId } })
        .catch(() => {});
    }
  }
  return {
    id: dataset.id,
    sourceIndex: dataset.sourceIndex,
    targetCollection: dataset.targetCollection,
    exists: true,
    sourceCount,
    writableCount,
    skippedCount,
    skippedReasons,
    bytes,
    fingerprint: hash.digest("hex"),
    documents,
  };
}

async function scanAll({
  client,
  datasets,
  identityMap,
  pageSize,
  collect,
  maxDocuments,
  maxBytes,
}) {
  const results = [];
  let remainingDocuments = maxDocuments;
  let remainingBytes = maxBytes;
  for (const dataset of datasets) {
    const result = await scanDataset({
      client,
      dataset,
      identityMap,
      pageSize,
      collect,
      maxDocuments: remainingDocuments,
      maxBytes: remainingBytes,
    });
    remainingDocuments -= result.sourceCount;
    remainingBytes -= result.bytes;
    results.push(result);
  }
  return results;
}

function publicPlan(results, identityMap) {
  const datasets = results.map(({ documents: _documents, ...result }) =>
    Object.freeze(result),
  );
  const sourceFingerprint = sha256(
    stableJson({
      identityMappings: identityMap.size,
      datasets: datasets.map(({ id, fingerprint }) => ({ id, fingerprint })),
    }),
  );
  return Object.freeze({
    mode: "plan",
    sourceFingerprint,
    confirmation: `${MIGRATION_CONFIRM_PREFIX}${sourceFingerprint}`,
    identityMappings: identityMap.size,
    sourceDocuments: datasets.reduce(
      (sum, dataset) => sum + dataset.sourceCount,
      0,
    ),
    writableDocuments: datasets.reduce(
      (sum, dataset) => sum + dataset.writableCount,
      0,
    ),
    skippedDocuments: datasets.reduce(
      (sum, dataset) => sum + dataset.skippedCount,
      0,
    ),
    datasets,
  });
}

export async function createOpenSearchToFirestorePlan({
  client,
  env = process.env,
  identityMap: identityMapValue = {},
  datasets = resolveGcpMigrationDatasets(env),
  pageSize = DEFAULT_PAGE_SIZE,
  maxDocuments = DEFAULT_MAX_DOCUMENTS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!client) {
    throw migrationError(
      "OpenSearch client не е конфигуриран.",
      "GCP_DATA_MIGRATION_SOURCE_UNAVAILABLE",
    );
  }
  const identityMap =
    identityMapValue instanceof Map
      ? identityMapValue
      : normalizeMigrationIdentityMap(identityMapValue);
  const results = await scanAll({
    client,
    datasets,
    identityMap,
    pageSize: positiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    collect: false,
    maxDocuments: positiveInteger(maxDocuments, DEFAULT_MAX_DOCUMENTS),
    maxBytes: positiveInteger(maxBytes, DEFAULT_MAX_BYTES),
  });
  return publicPlan(results, identityMap);
}

export async function applyOpenSearchToFirestoreMigration({
  client,
  documentStore,
  confirmation,
  env = process.env,
  identityMap: identityMapValue = {},
  datasets = resolveGcpMigrationDatasets(env),
  pageSize = DEFAULT_PAGE_SIZE,
  batchSize = 100,
  maxDocuments = DEFAULT_MAX_DOCUMENTS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!documentStore?.commitOperations || !documentStore?.get) {
    throw migrationError(
      "Firestore document store не е конфигуриран.",
      "GCP_DATA_MIGRATION_TARGET_UNAVAILABLE",
    );
  }
  const identityMap =
    identityMapValue instanceof Map
      ? identityMapValue
      : normalizeMigrationIdentityMap(identityMapValue);
  const plan = await createOpenSearchToFirestorePlan({
    client,
    env,
    identityMap,
    datasets,
    pageSize,
    maxDocuments,
    maxBytes,
  });
  if (String(confirmation || "").trim() !== plan.confirmation) {
    throw migrationError(
      "Липсва точното migration confirmation.",
      "GCP_DATA_MIGRATION_CONFIRMATION_REQUIRED",
    );
  }

  const collected = await scanAll({
    client,
    datasets,
    identityMap,
    pageSize: positiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    collect: true,
    maxDocuments: positiveInteger(maxDocuments, DEFAULT_MAX_DOCUMENTS),
    maxBytes: positiveInteger(maxBytes, DEFAULT_MAX_BYTES),
  });
  const collectedPlan = publicPlan(collected, identityMap);
  if (collectedPlan.sourceFingerprint !== plan.sourceFingerprint) {
    throw migrationError(
      "OpenSearch snapshot се промени след confirmation.",
      "GCP_DATA_MIGRATION_SOURCE_CHANGED",
    );
  }

  const safeBatchSize = positiveInteger(batchSize, 100, 250);
  let written = 0;
  let verified = 0;
  for (const dataset of collected) {
    for (
      let offset = 0;
      offset < dataset.documents.length;
      offset += safeBatchSize
    ) {
      const batch = dataset.documents.slice(offset, offset + safeBatchSize);
      await documentStore.commitOperations(
        batch.map((document) => ({
          type: "set",
          collection: dataset.targetCollection,
          id: document.targetId,
          data: document.targetData,
        })),
      );
      written += batch.length;
      for (const document of batch) {
        const stored = await documentStore.get(
          dataset.targetCollection,
          document.targetId,
        );
        if (
          !stored?.data ||
          stableJson(stored.data) !== stableJson(document.targetData)
        ) {
          throw migrationError(
            "Firestore post-write verification е неуспешна.",
            "GCP_DATA_MIGRATION_VERIFICATION_FAILED",
          );
        }
        verified += 1;
      }
    }
  }
  for (const dataset of collected) dataset.documents.length = 0;
  return Object.freeze({
    ...plan,
    mode: "applied",
    writtenDocuments: written,
    verifiedDocuments: verified,
  });
}

export const GCP_DATA_MIGRATION_CONFIRM_PREFIX = MIGRATION_CONFIRM_PREFIX;
