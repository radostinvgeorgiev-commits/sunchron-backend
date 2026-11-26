import { createHash, randomBytes } from "node:crypto";

import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// Read-only links to a conversation, like "Share" in ChatGPT and Claude.
// The link holds a copy of the messages taken when it was made: later
// messages, memory, projects and files are never included. Deleting the
// link removes the copy.
export const SHARE_COLLECTION = "synchron-shared-chats-v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 600_000;

export class ShareError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isShareToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

// One link per conversation; this key finds it without storing the token
// next to the owner in a guessable place.
function sessionKey(ownerId, sessionId) {
  return `session-${createHash("sha256").update(`${ownerId}\u0000${sessionId}`).digest("hex").slice(0, 40)}`;
}

export function snapshotMessages(items) {
  const messages = [];
  let total = 0;
  for (const item of (Array.isArray(items) ? items : []).slice(-MAX_MESSAGES)) {
    if (item?.role !== "user" && item?.role !== "assistant") continue;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) continue;
    total += content.length;
    if (total > MAX_TOTAL_CHARS) break;
    messages.push({ role: item.role, content });
  }
  return messages;
}

export function createShareService({
  store,
  env = process.env,
  listMessages,
  now = () => Date.now(),
  newToken = () => randomBytes(24).toString("base64url"),
} = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  function cleanSession(sessionId) {
    const value = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!value || value.length > 200) {
      throw new ShareError("Няма избран разговор.", 400, "SHARE_SESSION_REQUIRED");
    }
    return value;
  }

  async function status({ ownerId, sessionId }) {
    const row = await db().get(SHARE_COLLECTION, sessionKey(ownerId, cleanSession(sessionId)));
    const token = row?.data?.token;
    return isShareToken(token) ? { shared: true, token } : { shared: false };
  }

  async function create({ ownerId, sessionId, title }) {
    const session = cleanSession(sessionId);
    const messages = snapshotMessages(await listMessages(session, ownerId));
    if (!messages.length) {
      throw new ShareError("Разговорът още е празен или не е запазен.", 409, "SHARE_EMPTY");
    }
    const key = sessionKey(ownerId, session);
    const previous = await db().get(SHARE_COLLECTION, key);
    const token = newToken();
    const createdAt = new Date(now()).toISOString();
    const operations = [
      {
        type: "set",
        collection: SHARE_COLLECTION,
        id: token,
        data: {
          title:
            (typeof title === "string" && title.trim()) ||
            (messages.find((message) => message.role === "user")?.content || "Разговор")
              .replace(/\s+/gu, " ")
              .slice(0, 80),
          messages,
          createdAt,
        },
      },
      { type: "set", collection: SHARE_COLLECTION, id: key, data: { token, createdAt } },
    ];
    // A new link replaces the old one, so an earlier copy stops working.
    if (isShareToken(previous?.data?.token)) {
      operations.push({ type: "delete", collection: SHARE_COLLECTION, id: previous.data.token });
    }
    await db().commitOperations(operations);
    return { shared: true, token, messages: messages.length };
  }

  async function remove({ ownerId, sessionId }) {
    const key = sessionKey(ownerId, cleanSession(sessionId));
    const row = await db().get(SHARE_COLLECTION, key);
    const operations = [{ type: "delete", collection: SHARE_COLLECTION, id: key }];
    if (isShareToken(row?.data?.token)) {
      operations.push({ type: "delete", collection: SHARE_COLLECTION, id: row.data.token });
    }
    await db().commitOperations(operations);
    return { shared: false };
  }

  async function read(token) {
    if (!isShareToken(token)) return null;
    const row = await db().get(SHARE_COLLECTION, token);
    if (!row?.data || !Array.isArray(row.data.messages)) return null;
    return {
      title: row.data.title || "",
      createdAt: row.data.createdAt || null,
      messages: snapshotMessages(row.data.messages),
    };
  }

  return { status, create, remove, read };
}
