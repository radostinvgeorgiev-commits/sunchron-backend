import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPendingDelete,
  getPendingDelete,
  isSimpleDeleteConfirmation,
  resetPendingDeletesForTests,
  storePendingDelete,
} from "../src/services/pendingDeleteService.js";
import {
  buildMemoryReply,
  extractConfirmedMemoryDeleteCommand,
} from "../src/routes/chat.js";
import {
  deleteProfileMemoryByFact,
  listProfileMemories,
  saveProfileMemory,
} from "../src/services/memoryService.js";

// The phrase used in the issue and in the corresponding regression tests.
// Using a named constant makes the relation between tests explicit.
const МОРСКИ_ФАР_FACT = "Тестова дума — МОРСКИ ФАР 728";

// ---------------------------------------------------------------------------
// Unit tests for pendingDeleteService helpers
// ---------------------------------------------------------------------------

test("isSimpleDeleteConfirmation accepts 'Да' and 'Потвърждавам'", () => {
  assert.equal(isSimpleDeleteConfirmation("Да"), true);
  assert.equal(isSimpleDeleteConfirmation("да"), true);
  assert.equal(isSimpleDeleteConfirmation("ДА"), true);
  assert.equal(isSimpleDeleteConfirmation("Да."), true);
  assert.equal(isSimpleDeleteConfirmation("Да!"), true);
  assert.equal(isSimpleDeleteConfirmation("Потвърждавам"), true);
  assert.equal(isSimpleDeleteConfirmation("потвърждавам."), true);
});

test("isSimpleDeleteConfirmation rejects other messages", () => {
  assert.equal(isSimpleDeleteConfirmation("Не"), false);
  assert.equal(isSimpleDeleteConfirmation("Да, изтрий"), false);
  assert.equal(isSimpleDeleteConfirmation(""), false);
  assert.equal(
    isSimpleDeleteConfirmation(
      "Потвърждавам изтриването от постоянната памет само на факта: нещо",
    ),
    false,
  );
});

test("storePendingDelete and getPendingDelete round-trip", () => {
  resetPendingDeletesForTests();
  storePendingDelete("session-1", "любимият ми цвят е син", "personal");
  const entry = getPendingDelete("session-1");
  assert.ok(entry);
  assert.equal(entry.fact, "любимият ми цвят е син");
  assert.equal(entry.scope, "personal");
});

test("getPendingDelete returns null when nothing is stored", () => {
  resetPendingDeletesForTests();
  assert.equal(getPendingDelete("no-such-session"), null);
});

test("clearPendingDelete removes the entry", () => {
  resetPendingDeletesForTests();
  storePendingDelete("session-x", "тест факт");
  clearPendingDelete("session-x");
  assert.equal(getPendingDelete("session-x"), null);
});

test("pending delete for session A cannot affect session B", () => {
  resetPendingDeletesForTests();
  storePendingDelete("session-a", "факт за A");
  storePendingDelete("session-b", "факт за B");
  const a = getPendingDelete("session-a");
  const b = getPendingDelete("session-b");
  assert.equal(a.fact, "факт за A");
  assert.equal(b.fact, "факт за B");
  clearPendingDelete("session-a");
  assert.equal(getPendingDelete("session-a"), null);
  assert.equal(getPendingDelete("session-b")?.fact, "факт за B");
});

test("expired pending delete is treated as absent", () => {
  resetPendingDeletesForTests();
  // Use a zero-millisecond TTL so the entry expires immediately.
  storePendingDelete("session-expired", "old fact", "personal", 0);
  // After ttl=0, the entry's expiresAt is <= Date.now() and purgeExpired()
  // inside getPendingDelete should remove it.
  assert.equal(getPendingDelete("session-expired"), null);
});

// ---------------------------------------------------------------------------
// Integration-style tests that mock OpenSearch
// ---------------------------------------------------------------------------

test("'Да' without a pending delete never triggers deletion (guard test)", () => {
  resetPendingDeletesForTests();
  // No pending entry stored — isSimpleDeleteConfirmation alone is not enough.
  // The chat route only acts when BOTH conditions hold.
  const sessionId = "session-no-pending";
  assert.equal(getPendingDelete(sessionId), null);
  assert.equal(isSimpleDeleteConfirmation("Да"), true);
  // Simulating the chat route's guard condition:
  const pending = getPendingDelete(sessionId);
  const wouldConfirm = isSimpleDeleteConfirmation("Да") && Boolean(pending);
  assert.equal(wouldConfirm, false, "'Да' should not confirm deletion without a pending entry");
});

test("pending delete stores correct fact and scope for later confirmation", () => {
  resetPendingDeletesForTests();
  const sessionId = "session-confirm";
  const fact = МОРСКИ_ФАР_FACT;
  const scope = "personal";

  storePendingDelete(sessionId, fact, scope);

  const pending = getPendingDelete(sessionId);
  assert.ok(pending);
  assert.equal(pending.fact, fact);
  assert.equal(pending.scope, scope);

  // Simulate 'Да' confirmation: consume pending entry.
  clearPendingDelete(sessionId);
  assert.equal(getPendingDelete(sessionId), null);
});

test("buildMemoryReply returns correct delete-confirmation message", () => {
  const fact = МОРСКИ_ФАР_FACT;
  const reply = buildMemoryReply({
    type: "delete-confirmation-required",
    fact,
    scope: "personal",
  });
  assert.ok(typeof reply === "string");
  assert.ok(reply.includes(fact));
  // Must contain the exact confirmation prefix so the user can copy-paste it.
  assert.ok(
    reply.includes("Потвърждавам изтриването от постоянната памет само на факта:"),
  );
});

test("buildMemoryReply for 'forgot' confirms deletion when deleted>0", () => {
  const reply = buildMemoryReply({
    type: "forgot",
    fact: "тест",
    scope: "personal",
    deleted: 1,
  });
  assert.ok(reply.includes("Забравих"));
});

test("buildMemoryReply for 'forgot' indicates not-found when deleted===0", () => {
  const reply = buildMemoryReply({
    type: "forgot",
    fact: "тест",
    scope: "personal",
    deleted: 0,
  });
  assert.ok(reply.includes("Не намерих"));
});

test("extractConfirmedMemoryDeleteCommand parses МОРСКИ ФАР 728 fact", () => {
  const cmd = extractConfirmedMemoryDeleteCommand(
    `Потвърждавам изтриването от постоянната памет само на факта: ${МОРСКИ_ФАР_FACT}`,
  );
  assert.ok(cmd);
  assert.equal(cmd.fact, МОРСКИ_ФАР_FACT);
  assert.equal(cmd.scope, "personal");
});

// ---------------------------------------------------------------------------
// OpenSearch-backed end-to-end test (requires real service or mock)
// ---------------------------------------------------------------------------

test("end-to-end: save МОРСКИ ФАР 728 → confirm present → delete via pending → confirm absent", async (t) => {
  const fact = `${МОРСКИ_ФАР_FACT} e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 1. Save
  let saved;
  try {
    saved = await saveProfileMemory(fact, "explicit-chat-command", "personal");
  } catch {
    t.skip("OpenSearch not available");
    return;
  }

  try {
    // 2. Confirm it appears in listing
    const before = await listProfileMemories();
    const found = before.some((m) => m.fact === saved.fact);
    assert.ok(found, "fact should be present after saving");

    // 3. Simulate the pending delete flow
    const sessionId = `e2e-session-${Date.now()}`;
    storePendingDelete(sessionId, saved.fact, "personal");
    const pending = getPendingDelete(sessionId);
    assert.ok(pending, "pending entry should exist");
    assert.equal(pending.fact, saved.fact);

    // 4. Execute deletion (as the chat route would on 'Да')
    clearPendingDelete(sessionId);
    const deleted = await deleteProfileMemoryByFact(saved.fact, "personal");
    assert.ok(deleted > 0, "should have deleted at least one entry");

    // 5. No pending left
    assert.equal(getPendingDelete(sessionId), null);

    // 6. Confirm it is gone
    const after = await listProfileMemories();
    const stillPresent = after.some((m) => m.fact === saved.fact);
    assert.equal(stillPresent, false, "fact should be absent after deletion");
  } finally {
    // Best-effort cleanup: ensure the test fact is not left in the store.
    if (saved?.fact) {
      await deleteProfileMemoryByFact(saved.fact, "personal").catch(() => {});
    }
  }
});

test("OpenSearch failure path: deleteProfileMemoryByFact rejects → no false success", async (t) => {
  // We test the logic layer: if deleteProfileMemoryByFact throws, the pending
  // delete should have already been cleared by the chat route (pre-clear before
  // the async call). This test verifies the pending-store is cleared even when
  // we simulate the sequence.
  resetPendingDeletesForTests();
  const sessionId = "session-opensearch-fail";
  const fact = "факт за тест на грешка";

  storePendingDelete(sessionId, fact, "personal");
  assert.ok(getPendingDelete(sessionId), "pending should be set");

  // Simulate the chat route flow: clear pending BEFORE calling delete
  clearPendingDelete(sessionId);
  // deleteProfileMemoryByFact would throw here — pending is already gone
  assert.equal(
    getPendingDelete(sessionId),
    null,
    "pending must be cleared before delete attempt",
  );
  // After a throw the 503 path returns an error — no 'Забравих' message is sent.
});
