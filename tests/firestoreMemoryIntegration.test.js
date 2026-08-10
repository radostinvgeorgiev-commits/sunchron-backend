import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteProfileMemoryByFact,
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
  saveProfileMemory,
  setFirestoreMemoryStoreForTests,
} from "../src/services/memoryService.js";
import { runMemoryAcceptanceTest } from "../src/services/memoryAcceptanceService.js";

const ORIGINAL_ENV = Object.freeze({
  MEMORY_BACKEND: process.env.MEMORY_BACKEND,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID,
});

function createMemoryStoreDouble() {
  const profile = new Map();
  const conversations = new Map();

  return {
    backend: "firestore",
    async probe() {
      return { status: "green", backend: "firestore" };
    },
    async listProfileDocuments(ownerId, limit = 200) {
      return [...profile.entries()]
        .filter(([, data]) => data.ownerId === ownerId)
        .slice(0, limit)
        .map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
    async listConversationDocuments(ownerId, limit = 1000) {
      return [...conversations.entries()]
        .filter(([, data]) => data.ownerId === ownerId)
        .slice(0, limit)
        .map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
    async listConversationSessionDocuments(ownerId, sessionId, limit = 20) {
      return [...conversations.entries()]
        .filter(
          ([, data]) =>
            data.ownerId === ownerId && data.sessionId === sessionId,
        )
        .sort(([, left], [, right]) =>
          right.createdAt.localeCompare(left.createdAt),
        )
        .slice(0, limit)
        .map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
    async getProfileDocument(id) {
      const data = profile.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async commitProfileDocument({ id, data, deleteIds = [] }) {
      profile.set(id, structuredClone(data));
      for (const deleteId of deleteIds) profile.delete(deleteId);
    },
    async deleteProfileDocuments(ids) {
      for (const id of ids) profile.delete(id);
    },
    async commitConversationDocuments(documents) {
      for (const { id, data } of documents) {
        conversations.set(id, structuredClone(data));
      }
    },
  };
}

test.beforeEach(() => {
  process.env.MEMORY_BACKEND = "firestore";
  process.env.GOOGLE_CLOUD_PROJECT = "handy-boulevard-479120-q9";
  process.env.FIRESTORE_DATABASE_ID = "(default)";
  setFirestoreMemoryStoreForTests(createMemoryStoreDouble());
});

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setFirestoreMemoryStoreForTests(null);
});

test("Firestore memory isolates profile facts and conversations by owner", async () => {
  await saveProfileMemory(
    "Любимият ми цвят е син",
    "test",
    "personal",
    "owner-a",
  );
  await saveProfileMemory(
    "Любимият ми цвят е зелен",
    "test",
    "personal",
    "owner-b",
  );
  await saveConversationTurn("session-a", "Въпрос A", "Отговор A", "owner-a");
  await saveConversationTurn("session-a", "Въпрос B", "Отговор B", "owner-b");

  const ownerA = await listProfileMemories({
    ownerId: "owner-a",
    scope: "personal",
  });
  const ownerB = await listProfileMemories({
    ownerId: "owner-b",
    scope: "personal",
  });
  const conversationA = await listConversationMessages(
    "session-a",
    20,
    "owner-a",
  );

  assert.deepEqual(
    ownerA.map(({ fact }) => fact),
    ["Любимият ми цвят е син"],
  );
  assert.deepEqual(
    ownerB.map(({ fact }) => fact),
    ["Любимият ми цвят е зелен"],
  );
  assert.deepEqual(
    conversationA.map(({ content }) => content),
    ["Въпрос A", "Отговор A"],
  );
  assert.doesNotMatch(JSON.stringify(conversationA), /Въпрос B|Отговор B/u);
});

test("Firestore memory passes the isolated nine-step acceptance contract", async () => {
  const usedConfirmations = new Set();
  const report = await runMemoryAcceptanceTest({
    ownerId: "primary-owner",
    verifyDeleteGuard: async () => true,
    dependencies: {
      prepareMemoryDelete: async ({ target }) => ({
        confirmationId: "firestore-confirmation",
        target,
      }),
      confirmMemoryDelete: async ({
        confirmationId,
        expectedTarget,
        deleteByFact,
        ownerId,
      }) => {
        if (usedConfirmations.has(confirmationId)) {
          const error = new Error("already used");
          error.code = "CONFIRMATION_NOT_FOUND";
          throw error;
        }
        usedConfirmations.add(confirmationId);
        return {
          deleted: await deleteByFact(
            expectedTarget.fact,
            expectedTarget.scope,
            ownerId,
          ),
        };
      },
    },
  });

  assert.equal(report.status, "works");
  assert.equal(report.steps.length, 9);
  assert.equal(report.realMemoryUnchanged, true);
  assert.equal(report.cleanupCompleted, true);
});

test("Firestore deletion removes only the exact owner fact", async () => {
  const fact = "Тестовата ми дума е ОРФЕЙ-19";
  await saveProfileMemory(fact, "test", "personal", "owner-a");
  await saveProfileMemory(fact, "test", "personal", "owner-b");

  assert.equal(await deleteProfileMemoryByFact(fact, "personal", "owner-a"), 1);
  assert.deepEqual(
    await listProfileMemories({ ownerId: "owner-a", scope: "personal" }),
    [],
  );
  assert.equal(
    (await listProfileMemories({ ownerId: "owner-b", scope: "personal" }))
      .length,
    1,
  );
});
