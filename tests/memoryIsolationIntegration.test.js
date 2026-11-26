import assert from "node:assert/strict";
import test from "node:test";

import { createFirestoreMemoryStore } from "../src/services/firestoreMemoryStore.js";
import { createLocalDocumentStore } from "../src/services/localDocumentStore.js";
import {
  buildMemoryContext,
  deleteProfileMemoryByFact,
  listConversationMessages,
  listProfileMemories,
  profileMemoryDocumentId,
  saveConversationTurn,
  saveProfileMemory,
  setFirestoreMemoryStoreForTests,
} from "../src/services/memoryService.js";

const PROFILE_COLLECTION = "synchron-profile-memory-v1";

// The Firestore memory store over an in-process document store, installed as
// the memory service's store for one test.
function createMemoryClient({ failCommit = false } = {}) {
  const documents = createLocalDocumentStore();
  const documentStore = {
    ...documents,
    async commitOperations(operations) {
      if (failCommit) throw new Error("commit unavailable");
      return documents.commitOperations(operations);
    },
  };
  const store = createFirestoreMemoryStore({ env: {}, documentStore });
  setFirestoreMemoryStoreForTests(store);
  return {
    documents,
    seedProfile(id, data) {
      return documents.set(PROFILE_COLLECTION, id, data);
    },
    async profileFor(ownerId) {
      return (
        await documents.queryEqual(PROFILE_COLLECTION, "ownerId", ownerId)
      ).map(({ id, data }) => ({ id, ...data }));
    },
  };
}

test.after(() => setFirestoreMemoryStoreForTests(null));

test("profile memory IDs are deterministic without exposing owner or topic", () => {
  const first = profileMemoryDocumentId(
    "owner-a",
    "personal:preference:favorite-color",
  );
  const repeated = profileMemoryDocumentId(
    "owner-a",
    "personal:preference:favorite-color",
  );
  const otherOwner = profileMemoryDocumentId(
    "owner-b",
    "personal:preference:favorite-color",
  );

  assert.equal(first, repeated);
  assert.notEqual(first, otherOwner);
  assert.match(first, /^profile-[a-f0-9]{64}$/u);
  assert.doesNotMatch(first, /owner-a|favorite-color/u);
});

test("old topic key is replaced and a new conversation receives only KAMCHIA-7429", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-a";

  await client.seedProfile("legacy-code", {
    ownerId,
    fact: "моят тестов код е МОРСКИ ФАР 728",
    normalizedFact: "моят тестов код е морски фар 728",
    memoryKey: "personal:fact:моят тестов код е морски фар 728",
    category: "personal-fact",
    scope: "personal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "legacy",
  });

  const saved = await saveProfileMemory(
    "моят тестов код е KAMCHIA-7429",
    "integration-test",
    "personal",
    ownerId,
  );
  assert.equal(saved.replaced, true);

  const memories = await listProfileMemories({
    scope: "personal",
    ownerId,
  });
  const context = buildMemoryContext(memories);

  assert.match(context, /KAMCHIA-7429/u);
  assert.doesNotMatch(context, /МОРСКИ ФАР 728/u);
  assert.equal((await client.profileFor(ownerId)).length, 1);

  const freshSession = await listConversationMessages(
    "brand-new-session",
    20,
    ownerId,
  );
  assert.deepEqual(freshSession, []);
});

test("concurrent writes for one owner and topic leave one raw document", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-concurrent";

  const results = await Promise.all([
    saveProfileMemory(
      "Любимият ми цвят е син",
      "concurrency-test",
      "personal",
      ownerId,
    ),
    saveProfileMemory(
      "Любимият ми цвят е зелен",
      "concurrency-test",
      "personal",
      ownerId,
    ),
  ]);

  assert.equal(results[0].id, results[1].id);
  assert.equal((await client.profileFor(ownerId)).length, 1);
  assert.match((await client.profileFor(ownerId))[0].fact, /син|зелен/u);
});

test("a failed write never deletes the legacy document", async () => {
  const client = createMemoryClient({ failCommit: true });
  const ownerId = "owner-index-failure";
  await client.seedProfile("legacy-color", {
    ownerId,
    fact: "Любимият ми цвят е син",
    normalizedFact: "любимият ми цвят е син",
    memoryKey: "personal:preference:favorite-color",
    category: "preference",
    scope: "personal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "legacy",
  });

  await assert.rejects(
    () =>
      saveProfileMemory(
        "Любимият ми цвят е зелен",
        "failure-test",
        "personal",
        ownerId,
      ),
    /commit unavailable/u,
  );

  assert.equal((await client.profileFor(ownerId)).length, 1);
  assert.equal((await client.profileFor(ownerId))[0].id, "legacy-color");
});

test("user A never reads user B profile or conversation memory", async () => {
  const client = createMemoryClient();

  await saveProfileMemory(
    "моят тестов код е A-111",
    "integration-test",
    "personal",
    "owner-a",
  );
  await saveProfileMemory(
    "моят тестов код е B-222",
    "integration-test",
    "personal",
    "owner-b",
  );
  await saveConversationTurn(
    "shared-session-name",
    "Кодът ми?",
    "B-222",
    "owner-b",
  );

  const profileA = await listProfileMemories({
    scope: "personal",
    ownerId: "owner-a",
  });
  const conversationA = await listConversationMessages(
    "shared-session-name",
    20,
    "owner-a",
  );

  assert.deepEqual(
    profileA.map(({ fact }) => fact),
    ["моят тестов код е A-111"],
  );
  assert.deepEqual(conversationA, []);
  assert.doesNotMatch(buildMemoryContext(profileA), /B-222/u);
});

test("exact requested fact is deleted", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-exact-delete";
  const fact = "Любимият ми цвят е син";

  await saveProfileMemory(fact, "integration-test", "personal", ownerId);

  const deleted = await deleteProfileMemoryByFact(fact, "personal", ownerId);

  assert.equal(deleted, 1);
  assert.deepEqual(await client.profileFor(ownerId), []);
});

test("old fact from the same topic never deletes the current fact", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-stale-delete";

  await saveProfileMemory(
    "Любимият ми цвят е син",
    "integration-test",
    "personal",
    ownerId,
  );

  const deleted = await deleteProfileMemoryByFact(
    "Любимият ми цвят е червен",
    "personal",
    ownerId,
  );

  assert.equal(deleted, 0);
  assert.deepEqual(
    (await client.profileFor(ownerId)).map(({ fact }) => fact),
    ["Любимият ми цвят е син"],
  );
});

test("different normalized fact with the same memory key is preserved", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-same-key-delete";

  await client.seedProfile("current-color", {
    ownerId,
    fact: "Любимият ми цвят е син",
    normalizedFact: "любимият ми цвят е син",
    memoryKey: "personal:preference:favorite-color",
    category: "preference",
    scope: "personal",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    source: "integration-test",
  });

  const deleted = await deleteProfileMemoryByFact(
    "Любимият ми цвят е зелен",
    "personal",
    ownerId,
  );

  assert.equal(deleted, 0);
  assert.equal((await client.profileFor(ownerId)).length, 1);
  assert.equal(
    (await client.profileFor(ownerId))[0].fact,
    "Любимият ми цвят е син",
  );
});
