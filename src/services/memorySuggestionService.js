import { createHash } from "node:crypto";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";
import {
  normalizeProfileMemoryDraft,
  saveProfileMemory,
} from "./memoryService.js";
import { assertMemoryWriteAllowed } from "./memoryWriteConfirmationService.js";
import { loadWorkspaceState } from "./workspaceStateService.js";

// Memory inbox: AI assistants (Claude, ChatGPT, the AI CORE chat) suggest
// facts; nothing reaches permanent memory until the owner approves it on the
// site. Suggestions wait up to 30 days.

export const MEMORY_SUGGESTION_COLLECTION = "synchron-memory-suggestions-v1";
export const MEMORY_SUGGESTION_TTL_MS = 30 * 86_400_000;
export const MAX_PENDING_SUGGESTIONS = 100;
const SOURCES = new Set(["claude", "chatgpt", "gemini", "ai-core", "other"]);

export class MemorySuggestionError extends Error {
  constructor(message, status = 400, code = "MEMORY_SUGGESTION_INVALID") {
    super(message);
    this.name = "MemorySuggestionError";
    this.status = status;
    this.code = code;
  }
}

let storeOverride = null;
let runtimeStore = null;

export function setMemorySuggestionStoreForTests(store) {
  storeOverride = store;
}

function store(env) {
  if (storeOverride) return storeOverride;
  if (resolvePersistenceBackend(env) !== "firestore") {
    throw new MemorySuggestionError(
      "Входящите предложения временно не са достъпни.",
      503,
      "MEMORY_SUGGESTIONS_UNAVAILABLE",
    );
  }
  return (runtimeStore ||= createFirestoreDocumentStore({ env }));
}

function suggestionId(ownerId, fact, scope) {
  return createHash("sha256")
    .update(`${ownerId}\u0000${scope}\u0000${fact.toLowerCase()}`)
    .digest("hex")
    .slice(0, 40);
}

function cleanOwner(ownerId) {
  const value = typeof ownerId === "string" ? ownerId.trim() : "";
  if (!value) {
    throw new MemorySuggestionError(
      "Липсва профил.",
      401,
      "AUTH_REQUIRED",
    );
  }
  return value;
}

function publicSuggestion(document) {
  const data = document.data || {};
  return {
    id: document.id,
    fact: data.fact,
    scope: data.scope,
    source: data.source,
    createdAt: data.createdAt,
  };
}

export async function listMemorySuggestions(
  ownerId,
  { env = process.env, now = Date.now } = {},
) {
  const owner = cleanOwner(ownerId);
  const documents = await store(env).queryEqual(
    MEMORY_SUGGESTION_COLLECTION,
    "ownerId",
    owner,
    MAX_PENDING_SUGGESTIONS * 2,
  );
  const current = now();
  return documents
    .filter(
      (document) =>
        document.data?.ownerId === owner &&
        Date.parse(document.data?.expiresAt || "") > current,
    )
    .sort((a, b) =>
      String(b.data?.createdAt || "").localeCompare(
        String(a.data?.createdAt || ""),
      ),
    )
    .slice(0, MAX_PENDING_SUGGESTIONS)
    .map(publicSuggestion);
}

export async function suggestMemory(
  { ownerId, fact, scope = "personal", source = "other" },
  { env = process.env, now = Date.now } = {},
) {
  const owner = cleanOwner(ownerId);
  let draft;
  try {
    draft = normalizeProfileMemoryDraft(fact, scope);
  } catch (error) {
    throw new MemorySuggestionError(
      error.message || "Невалиден факт.",
      400,
      "MEMORY_SUGGESTION_INVALID",
    );
  }
  const cleanSource = SOURCES.has(source) ? source : "other";
  const pending = await listMemorySuggestions(owner, { env, now });
  const id = suggestionId(owner, draft.fact, draft.scope);
  const existing = pending.find((item) => item.id === id);
  if (existing) return { ...existing, duplicate: true };
  if (pending.length >= MAX_PENDING_SUGGESTIONS) {
    throw new MemorySuggestionError(
      "Входящите са пълни. Прегледай чакащите предложения в AI CORE.",
      429,
      "MEMORY_SUGGESTIONS_FULL",
    );
  }
  const createdAt = new Date(now()).toISOString();
  const data = {
    ownerId: owner,
    fact: draft.fact,
    scope: draft.scope,
    source: cleanSource,
    createdAt,
    expiresAt: new Date(now() + MEMORY_SUGGESTION_TTL_MS).toISOString(),
  };
  await store(env).set(MEMORY_SUGGESTION_COLLECTION, id, data);
  return publicSuggestion({ id, data });
}

async function ownedSuggestion(owner, id, env) {
  const cleanId = typeof id === "string" ? id.trim() : "";
  if (!/^[a-f0-9]{40}$/u.test(cleanId)) {
    throw new MemorySuggestionError("Невалидно предложение.");
  }
  const document = await store(env).get(MEMORY_SUGGESTION_COLLECTION, cleanId);
  if (!document || document.data?.ownerId !== owner) {
    throw new MemorySuggestionError(
      "Предложението не е намерено.",
      404,
      "MEMORY_SUGGESTION_NOT_FOUND",
    );
  }
  return { id: cleanId, data: document.data };
}

export async function approveMemorySuggestion(
  { ownerId, id, fact },
  {
    env = process.env,
    saveMemory = saveProfileMemory,
    loadWorkspace = loadWorkspaceState,
  } = {},
) {
  const owner = cleanOwner(ownerId);
  const suggestion = await ownedSuggestion(owner, id, env);
  await assertMemoryWriteAllowed(owner, loadWorkspace, env);
  const finalFact =
    typeof fact === "string" && fact.trim() ? fact : suggestion.data.fact;
  const saved = await saveMemory(
    finalFact,
    `inbox-approved:${suggestion.data.source || "other"}`,
    suggestion.data.scope,
    owner,
  );
  await store(env).delete(MEMORY_SUGGESTION_COLLECTION, suggestion.id);
  return { approved: true, memory: saved };
}

export async function dismissMemorySuggestion(
  { ownerId, id },
  { env = process.env } = {},
) {
  const owner = cleanOwner(ownerId);
  const suggestion = await ownedSuggestion(owner, id, env);
  await store(env).delete(MEMORY_SUGGESTION_COLLECTION, suggestion.id);
  return { dismissed: true };
}
