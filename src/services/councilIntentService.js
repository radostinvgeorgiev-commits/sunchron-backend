import { createHash, randomUUID } from "node:crypto";

import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

const DEFAULT_COLLECTION = "synchron-council-intents-v1";
const MAX_QUESTION_LENGTH = 6_000;
const MAX_RECOMMENDATION_LENGTH = 2_000;
const MAX_RATIONALE_LENGTH = 4_000;
const MAX_NEXT_STEPS = 8;
const MAX_STEP_LENGTH = 600;
const INTENT_TTL_MS = 30 * 60 * 1000;
const SAFE_ID_PATTERN = /^council-[a-z0-9-]{8,80}$/iu;

let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;
const intentLocks = new Map();

export class CouncilIntentError extends Error {
  constructor(message, status = 400, code = "COUNCIL_INTENT_ERROR") {
    super(message);
    this.name = "CouncilIntentError";
    this.status = status;
    this.code = code;
  }
}

export function setFirestoreCouncilIntentStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}

function cleanText(value, maxLength, label, { required = false } = {}) {
  const text =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
      : "";
  if (required && !text) {
    throw new CouncilIntentError(`Липсва ${label}.`, 400, "COUNCIL_INTENT_INVALID");
  }
  if (text.length > maxLength) {
    throw new CouncilIntentError(
      `${label} е прекалено дълго.`,
      413,
      "COUNCIL_INTENT_TOO_LONG",
    );
  }
  return text;
}

function cleanId(value) {
  const id = cleanText(value, 100, "идентификатор", { required: true });
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new CouncilIntentError(
      "Невалиден идентификатор на Council препоръката.",
      400,
      "COUNCIL_INTENT_ID_INVALID",
    );
  }
  return id;
}

function hashOwner(ownerId) {
  const owner = cleanText(ownerId, 200, "профил", { required: true });
  return createHash("sha256")
    .update("synchron-council-owner-v1\0")
    .update(owner)
    .digest("hex");
}

function collectionName(env) {
  const value = String(
    env.FIRESTORE_COUNCIL_INTENT_COLLECTION || DEFAULT_COLLECTION,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    throw new CouncilIntentError(
      "Невалидна Firestore колекция за Council препоръки.",
      503,
      "COUNCIL_INTENT_STORAGE_UNAVAILABLE",
    );
  }
  return value;
}

function getStore(env = process.env) {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    env.GOOGLE_CLOUD_PROJECT,
    env.GCLOUD_PROJECT,
    env.GCP_PROJECT_ID,
    env.FIRESTORE_DATABASE_ID,
    env.FIRESTORE_COUNCIL_INTENT_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    const documentStore = createFirestoreDocumentStore({ env });
    const collection = collectionName(env);
    firestoreStore = {
      get: (id, options) => documentStore.get(collection, id, options),
      set: (id, data, options) => documentStore.set(collection, id, data, options),
    };
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

function requireStore(env) {
  const project = String(
    env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT_ID || "",
  ).trim();
  const persistence = String(env.PERSISTENCE_BACKEND || "").trim().toLowerCase();
  if (persistence !== "firestore" || !project) {
    throw new CouncilIntentError(
      "Устойчивото Council продължаване временно изисква Firestore.",
      503,
      "COUNCIL_INTENT_STORAGE_UNAVAILABLE",
    );
  }
  return getStore(env);
}

function normalizeSteps(value) {
  return Object.freeze(
    (Array.isArray(value) ? value : [])
      .slice(0, MAX_NEXT_STEPS)
      .map((item) => cleanText(item, MAX_STEP_LENGTH, "следваща стъпка"))
      .filter(Boolean),
  );
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  return typeof value === "string" ? value : new Date(value).toISOString();
}

function intentFromData(id, data = {}) {
  return Object.freeze({
    id,
    question: cleanText(data.question, MAX_QUESTION_LENGTH, "заявка"),
    recommendation: cleanText(
      data.recommendation,
      MAX_RECOMMENDATION_LENGTH,
      "препоръка",
    ),
    rationale: cleanText(data.rationale, MAX_RATIONALE_LENGTH, "обосновка"),
    nextSteps: normalizeSteps(data.nextSteps),
    status: data.status === "selected" ? "selected" : "proposed",
    createdAt: data.createdAt || null,
    expiresAt: data.expiresAt || null,
  });
}

function assertActive(intent, now) {
  if (intent.status !== "proposed") {
    throw new CouncilIntentError(
      "Тази Council препоръка вече е използвана.",
      409,
      "COUNCIL_INTENT_ALREADY_USED",
    );
  }
  const expiresAt = Date.parse(intent.expiresAt || "");
  if (Number.isFinite(expiresAt) && expiresAt <= Date.parse(now)) {
    throw new CouncilIntentError(
      "Council препоръката е изтекла. Направи ново обсъждане.",
      410,
      "COUNCIL_INTENT_EXPIRED",
    );
  }
}

export async function createCouncilIntent(
  {
    ownerId,
    sessionId,
    question,
    recommendation,
    rationale,
    nextSteps,
  } = {},
  {
    env = process.env,
    now = () => new Date().toISOString(),
    createId = randomUUID,
  } = {},
) {
  const at = nowIso(now);
  const id = `council-${createId().replace(/[^a-z0-9-]/giu, "").slice(0, 64)}`;
  const data = {
    ownerHash: hashOwner(ownerId),
    sessionId: cleanText(sessionId, 160, "сесия", { required: true }),
    question: cleanText(question, MAX_QUESTION_LENGTH, "заявка", {
      required: true,
    }),
    recommendation: cleanText(
      recommendation,
      MAX_RECOMMENDATION_LENGTH,
      "препоръка",
      { required: true },
    ),
    rationale: cleanText(rationale, MAX_RATIONALE_LENGTH, "обосновка", {
      required: true,
    }),
    nextSteps: normalizeSteps(nextSteps),
    status: "proposed",
    createdAt: at,
    expiresAt: new Date(Date.parse(at) + INTENT_TTL_MS).toISOString(),
  };
  await requireStore(env).set(id, data);
  return Object.freeze({ id, ...intentFromData(id, data) });
}

export async function consumeCouncilIntent(
  { ownerId, sessionId, intentId } = {},
  { env = process.env, now = () => new Date().toISOString() } = {},
) {
  const id = cleanId(intentId);
  const previous = intentLocks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  intentLocks.set(id, current);
  await previous;
  try {
    const store = requireStore(env);
    const stored = await store.get(id, { includeMetadata: true });
    if (!stored || stored.data?.ownerHash !== hashOwner(ownerId)) {
      throw new CouncilIntentError(
        "Council препоръката не е намерена.",
        404,
        "COUNCIL_INTENT_NOT_FOUND",
      );
    }
    const intent = intentFromData(id, stored.data);
    if (
      cleanText(sessionId, 160, "сесия", { required: true }) !==
      stored.data.sessionId
    ) {
      throw new CouncilIntentError(
        "Council препоръката принадлежи на друга сесия.",
        409,
        "COUNCIL_INTENT_SESSION_MISMATCH",
      );
    }
    const at = nowIso(now);
    assertActive(intent, at);
    const selected = {
      ...stored.data,
      status: "selected",
      selectedAt: at,
    };
    try {
      await store.set(
        id,
        selected,
        stored.updateTime ? { updateTime: stored.updateTime } : undefined,
      );
    } catch (error) {
      if (error?.upstreamErrorStatus === "FAILED_PRECONDITION") {
        throw new CouncilIntentError(
          "Тази Council препоръка вече е използвана.",
          409,
          "COUNCIL_INTENT_ALREADY_USED",
        );
      }
      throw error;
    }
    return Object.freeze({ id, ...intentFromData(id, selected) });
  } finally {
    release();
    if (intentLocks.get(id) === current) intentLocks.delete(id);
  }
}
