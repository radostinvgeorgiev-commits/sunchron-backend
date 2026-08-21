import assert from "node:assert/strict";
import test from "node:test";

import { createFirestoreMemoryStore } from "../src/services/firestoreMemoryStore.js";

test("conversation reads use the owner index and preserve newest session context", async () => {
  const calls = [];
  const documents = [
    {
      id: "old",
      data: {
        ownerId: "owner-a",
        sessionId: "session-a",
        role: "user",
        content: "Стар въпрос",
        createdAt: "2026-08-21T10:00:00.000Z",
      },
    },
    {
      id: "other-session",
      data: {
        ownerId: "owner-a",
        sessionId: "session-b",
        role: "assistant",
        content: "Друг разговор",
        createdAt: "2026-08-21T12:00:00.000Z",
      },
    },
    {
      id: "new",
      data: {
        ownerId: "owner-a",
        sessionId: "session-a",
        role: "assistant",
        content: "Да я изпълня ли?",
        createdAt: "2026-08-21T11:00:00.000Z",
      },
    },
  ];
  const documentStore = {
    async queryEqual(collection, field, value, limit) {
      calls.push({ collection, field, value, limit });
      return structuredClone(documents);
    },
  };
  const store = createFirestoreMemoryStore({
    env: {
      GOOGLE_CLOUD_PROJECT: "test-project",
      FIRESTORE_DATABASE_ID: "(default)",
    },
    documentStore,
  });

  const all = await store.listConversationDocuments("owner-a", 2);
  const session = await store.listConversationSessionDocuments(
    "owner-a",
    "session-a",
    2,
  );

  assert.deepEqual(
    all.map(({ id }) => id),
    ["other-session", "new"],
  );
  assert.deepEqual(
    session.map(({ id }) => id),
    ["new", "old"],
  );
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.field === "ownerId" &&
        call.value === "owner-a" &&
        call.limit === 1_000,
    ),
  );
});
