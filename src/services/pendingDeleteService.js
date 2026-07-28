/**
 * Server-side pending memory-delete store.
 *
 * When a user requests deletion of a specific memory fact the chat route
 * stores a pending action here, keyed by sessionId, and waits for an
 * explicit confirmation in the next message.  The store is intentionally
 * in-process (no external dependency) and entries expire automatically
 * after PENDING_DELETE_TTL_MS to prevent stale confirmations.
 */

const PENDING_DELETE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, { fact: string, scope: string, expiresAt: number }>} */
const pendingDeletes = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [key, entry] of pendingDeletes) {
    if (entry.expiresAt <= now) {
      pendingDeletes.delete(key);
    }
  }
}

/**
 * Stores a pending delete for the given session.
 * Any previous pending delete for the same session is replaced.
 * @param {string} sessionId
 * @param {string} fact
 * @param {string} [scope]
 * @param {number} [ttlMs]  – override for tests; defaults to PENDING_DELETE_TTL_MS
 */
export function storePendingDelete(
  sessionId,
  fact,
  scope = "personal",
  ttlMs = PENDING_DELETE_TTL_MS,
) {
  purgeExpired();
  pendingDeletes.set(sessionId, {
    fact,
    scope,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Returns the pending delete entry for the given session, or null if none
 * exists or it has expired.
 */
export function getPendingDelete(sessionId) {
  purgeExpired();
  return pendingDeletes.get(sessionId) ?? null;
}

/**
 * Removes the pending delete entry for the given session.
 * Safe to call even if no entry exists.
 */
export function clearPendingDelete(sessionId) {
  pendingDeletes.delete(sessionId);
}

/**
 * Returns true when the message is a short unconditional confirmation
 * ("Да", "Потвърждавам", optionally followed by punctuation).
 * This is intentionally narrow so that normal conversational "Да" answers
 * are only treated as confirmations when there is an active pending delete.
 *
 * Whitespace between the word and any trailing punctuation (e.g. "Да .")
 * is intentionally rejected to keep the pattern unambiguous.  Callers
 * should call message.trim() before passing the value.
 */
export function isSimpleDeleteConfirmation(message) {
  return /^(?:да|потвърждавам)[.!]?$/iu.test(message.trim());
}

/** Test helper — clears all pending deletes. */
export function resetPendingDeletesForTests() {
  pendingDeletes.clear();
}
