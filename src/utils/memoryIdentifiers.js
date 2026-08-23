import { createHash } from "node:crypto";

function namespacedHash(prefix, ...parts) {
  const hash = createHash("sha256");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\0");
    hash.update(String(part));
  });
  return `${prefix}${hash.digest("hex")}`;
}

export function profileMemoryDocumentId(ownerId, memoryKey) {
  const owner = String(ownerId || "").trim();
  const key = String(memoryKey || "").trim();
  if (!owner || !key) {
    throw new TypeError("Profile memory document ID requires owner and key.");
  }

  return namespacedHash("profile-", owner, key);
}

export function conversationSummaryDocumentId(ownerId, sessionId) {
  const owner = String(ownerId || "").trim();
  const session = String(sessionId || "").trim();
  if (!owner || !session) {
    throw new TypeError(
      "Conversation summary document ID requires owner and session.",
    );
  }

  return namespacedHash("conversation-", owner, session);
}

export function conversationMessageDocumentId(
  ownerId,
  sessionId,
  turnId,
  role,
) {
  const owner = String(ownerId || "").trim();
  const session = String(sessionId || "").trim();
  const turn = String(turnId || "").trim();
  const cleanRole = String(role || "").trim();
  if (!owner || !session || !turn || !cleanRole) {
    throw new TypeError(
      "Conversation message document ID requires owner, session, turn and role.",
    );
  }

  return namespacedHash("message-", owner, session, turn, cleanRole);
}

export function safeMemoryReference(value) {
  const cleanValue = String(value || "").trim();
  return cleanValue
    ? createHash("sha256").update(cleanValue).digest("hex").slice(0, 16)
    : null;
}
