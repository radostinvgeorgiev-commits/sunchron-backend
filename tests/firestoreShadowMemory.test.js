import assert from "node:assert/strict";
import test from "node:test";

import { setOpenSearchClientForTests } from "../src/config/opensearch.js";
import {
  resetFirestoreMemoryAdapterForTests,
  setFirestoreMemoryAdapterForTests,
} from "../src/services/firestoreMemoryAdapter.js";
import { resetAuditFallbackForTests } from "../src/services/permissionService.js";
import {
  deleteProfileMemory,
  flushFirestoreShadowForTests,
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
  saveProfileMemory,
} from "../src/services/memoryService.js";

function createOpenSearchClient({
  profileIndexError = false,
  conversationError = false,
} = {}) {
  const events = [];
  const auditEntries = [];

  return {
    events,
    auditEntries,
    indices: {
      exists: async () => ({ body: true }),
      putMapping: async () => ({ body: { acknowledged: true } }),
    },
    async search({ index }) {
      events.push(`opensearch-search:${index}`);
      return { body: { hits: { hits: [] } } };
    },
    async index({ index, id, body }) {
      if (index === "synchron-action-audit") {
        auditEntries.push({ id, body });
        return { body: { result: "created" } };
      }
      events.push("opensearch-profile-index");
      if (profileIndexError) throw new Error("OpenSearch profile unavailable");
      return { body: { result: "created" } };
    },
    async bulk({ body }) {
      events.push("opensearch-conversation-bulk");
      if (conversationError) return { body: { errors: true } };
      return { body: { errors: false } };
    },
    async deleteByQuery() {
      events.push("opensearch-delete");
      return { body: { deleted: 1 } };
    },
  };
}

test.afterEach(async () => {
  await flushFirestoreShadowForTests();
  resetFirestoreMemoryAdapterForTests();
  resetAuditFallbackForTests();
  setOpenSearchClientForTests(null);
});

test("OpenSearch remains the only read source when Firestore shadow is enabled", async () => {
  const client = createOpenSearchClient();
  const adapterCalls = [];
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async listProfileMemories() {
      adapterCalls.push("profile-read");
      throw new Error("Firestore reads must not be used");
    },
    async listConversationMessages() {
      adapterCalls.push("conversation-read");
      throw new Error("Firestore reads must not be used");
    },
  });

  assert.deepEqual(
    await listProfileMemories({ ownerId: "owner-a", scope: "personal" }),
    [],
  );
  assert.deepEqual(
    await listConversationMessages("session-a", 20, "owner-a"),
    [],
  );
  assert.deepEqual(adapterCalls, []);
});

test("successful OpenSearch writes are mirrored only after the authoritative operation", async () => {
  const client = createOpenSearchClient();
  const turnIds = [];
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory({ ownerId, memory }) {
      client.events.push(`firestore-profile:${ownerId}:${memory.fact}`);
    },
    async saveConversationTurn({ ownerId, sessionId, turnId }) {
      turnIds.push(turnId);
      client.events.push(`firestore-conversation:${ownerId}:${sessionId}`);
    },
  });

  await saveProfileMemory(
    "Любимият ми цвят е син",
    "shadow-test",
    "personal",
    "owner-a",
  );
  await saveConversationTurn("session-a", "Въпрос", "Отговор", "owner-a");
  await flushFirestoreShadowForTests();

  assert.deepEqual(
    client.events.filter(
      (event) =>
        event.startsWith("opensearch-") || event.startsWith("firestore-"),
    ),
    [
      "opensearch-search:synchron-profile-memory-v1",
      "opensearch-profile-index",
      "firestore-profile:owner-a:Любимият ми цвят е син",
      "opensearch-conversation-bulk",
      "firestore-conversation:owner-a:session-a",
    ],
  );
  assert.notEqual(turnIds[0], undefined);
});

test("conversation retries preserve the supplied shadow turn id", async () => {
  const client = createOpenSearchClient();
  const turnIds = [];
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async saveConversationTurn({ turnId }) {
      turnIds.push(turnId);
    },
  });

  await saveConversationTurn(
    "session-retry",
    "Въпрос",
    "Отговор",
    "owner-a",
    "turn-retry-1",
  );
  await saveConversationTurn(
    "session-retry",
    "Въпрос",
    "Отговор",
    "owner-a",
    "turn-retry-1",
  );
  await flushFirestoreShadowForTests();

  assert.deepEqual(turnIds, ["turn-retry-1", "turn-retry-1"]);
});

test("authoritative OpenSearch failure never starts the Firestore shadow", async () => {
  const client = createOpenSearchClient({
    profileIndexError: true,
    conversationError: true,
  });
  const adapterCalls = [];
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory() {
      adapterCalls.push("profile");
    },
    async saveConversationTurn() {
      adapterCalls.push("conversation");
    },
  });

  await assert.rejects(
    saveProfileMemory(
      "Любимият ми цвят е син",
      "shadow-test",
      "personal",
      "owner-a",
    ),
    /OpenSearch profile unavailable/u,
  );
  await assert.rejects(
    saveConversationTurn("session-a", "Въпрос", "Отговор", "owner-a"),
    (error) => error.code === "CONVERSATION_PERSISTENCE_FAILED",
  );
  assert.deepEqual(adapterCalls, []);
});

test("Firestore shadow failure preserves the authoritative result and records safe audit metadata", async () => {
  const client = createOpenSearchClient();
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory() {
      const error = new Error("Firestore contains private details");
      error.code = "FIRESTORE_PROFILE_WRITE_FAILED";
      throw error;
    },
  });

  const result = await saveProfileMemory(
    "Личен факт, който не трябва да се логва",
    "shadow-test",
    "personal",
    "owner-a",
  );
  await flushFirestoreShadowForTests();

  assert.equal(result.fact, "Личен факт, който не трябва да се логва");
  assert.equal(client.auditEntries.length, 1);
  assert.deepEqual(
    {
      action: client.auditEntries[0].body.action,
      capability: client.auditEntries[0].body.capability,
      phase: client.auditEntries[0].body.phase,
      outcome: client.auditEntries[0].body.outcome,
      resource: client.auditEntries[0].body.resource,
    },
    {
      action: "memory.write",
      capability: "memory.firestore.shadow",
      phase: "shadow",
      outcome: "failed",
      resource: "firestore-shadow",
    },
  );
  const serialized = JSON.stringify(client.auditEntries[0].body);
  assert.match(serialized, /FIRESTORE_PROFILE_WRITE_FAILED/u);
  assert.doesNotMatch(
    serialized,
    /owner-a|Личен факт, който не трябва да се логва|Firestore contains private details/u,
  );
});

test("protected OpenSearch delete mirrors only after a successful authoritative delete", async () => {
  const client = createOpenSearchClient();
  const adapterCalls = [];
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async deleteProfileMemoryById(input) {
      adapterCalls.push(input);
    },
  });

  assert.equal(await deleteProfileMemory("profile-id", "owner-a"), true);
  await flushFirestoreShadowForTests();
  assert.deepEqual(adapterCalls, [{ ownerId: "owner-a", id: "profile-id" }]);
});

test("Firestore shadow work does not hold the authoritative response", async () => {
  const client = createOpenSearchClient();
  let releaseMirror;
  let mirrorStarted = false;
  let mirrorCompleted = false;
  const mirrorBlocked = new Promise((resolve) => {
    releaseMirror = resolve;
  });
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory() {
      mirrorStarted = true;
      await mirrorBlocked;
      mirrorCompleted = true;
    },
  });

  const result = await saveProfileMemory(
    "Кратък authoritative резултат",
    "shadow-test",
    "personal",
    "owner-a",
  );

  assert.equal(result.fact, "Кратък authoritative резултат");
  assert.equal(mirrorStarted, true);
  assert.equal(mirrorCompleted, false);
  releaseMirror();
  await flushFirestoreShadowForTests();
  assert.equal(mirrorCompleted, true);
});

test("Firestore shadow queue applies a bounded drop policy during an outage", async () => {
  const client = createOpenSearchClient();
  let releaseFirstMirror;
  let mirrorCalls = 0;
  const firstMirrorBlocked = new Promise((resolve) => {
    releaseFirstMirror = resolve;
  });
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory() {
      mirrorCalls += 1;
      if (mirrorCalls === 1) await firstMirrorBlocked;
    },
  });

  await saveProfileMemory(
    "Първи факт",
    "shadow-backpressure",
    "personal",
    "owner-a",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mirrorCalls, 1);

  await Promise.all(
    Array.from({ length: 70 }, (_, index) =>
      saveProfileMemory(
        `Факт ${index}`,
        `shadow-backpressure-${index}`,
        "personal",
        "owner-a",
      ),
    ),
  );
  assert.equal(mirrorCalls, 1);

  releaseFirstMirror();
  await flushFirestoreShadowForTests();

  assert.equal(mirrorCalls, 64);
  assert.ok(
    client.auditEntries.some((entry) =>
      entry.body.details.includes("FIRESTORE_SHADOW_QUEUE_FULL"),
    ),
  );
});

test("Firestore shadow operations stay ordered per owner resource", async () => {
  const client = createOpenSearchClient();
  const events = [];
  let releaseFirstMirror;
  const firstMirrorBlocked = new Promise((resolve) => {
    releaseFirstMirror = resolve;
  });
  setOpenSearchClientForTests(client);
  setFirestoreMemoryAdapterForTests({
    async upsertProfileMemory() {
      events.push("upsert-start");
      await firstMirrorBlocked;
      events.push("upsert-complete");
    },
    async deleteProfileMemoryById() {
      events.push("delete");
    },
  });

  await saveProfileMemory(
    "Факт за подредба",
    "shadow-ordering",
    "personal",
    "owner-a",
  );
  await deleteProfileMemory("profile-id", "owner-a");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["upsert-start"]);
  releaseFirstMirror();
  await flushFirestoreShadowForTests();
  assert.deepEqual(events, ["upsert-start", "upsert-complete", "delete"]);
});
