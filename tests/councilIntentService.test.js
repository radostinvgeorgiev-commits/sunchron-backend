import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  consumeCouncilIntent,
  CouncilIntentError,
  createCouncilIntent,
  setFirestoreCouncilIntentStoreForTests,
} from "../src/services/councilIntentService.js";

const env = {
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
};

function fakeStore() {
  const documents = new Map();
  return {
    documents,
    async get(id) {
      const data = documents.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async set(id, data) {
      documents.set(id, structuredClone(data));
    },
  };
}

afterEach(() => setFirestoreCouncilIntentStoreForTests(null));

test("Council intent is owner and session scoped and can be consumed once", async () => {
  const store = fakeStore();
  setFirestoreCouncilIntentStoreForTests(store);
  const intent = await createCouncilIntent(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      question: "Как да продължа?",
      recommendation: "Първо направи read-only проверка.",
      rationale: "Така рискът остава нисък.",
      nextSteps: ["Провери статуса."],
    },
    { env, createId: () => "abc12345", now: () => "2026-08-21T10:00:00.000Z" },
  );

  assert.equal(intent.id, "council-abc12345");
  assert.equal(JSON.stringify(store.documents).includes("owner-1"), false);
  const selected = await consumeCouncilIntent(
    { ownerId: "owner-1", sessionId: "session-1", intentId: intent.id },
    { env, now: () => "2026-08-21T10:01:00.000Z" },
  );
  assert.equal(selected.status, "selected");
  await assert.rejects(
    () =>
      consumeCouncilIntent(
        { ownerId: "owner-1", sessionId: "session-1", intentId: intent.id },
        { env, now: () => "2026-08-21T10:02:00.000Z" },
      ),
    (error) =>
      error instanceof CouncilIntentError &&
      error.code === "COUNCIL_INTENT_ALREADY_USED" &&
      error.status === 409,
  );
});

test("Council intent blocks a different owner or session", async () => {
  const store = fakeStore();
  setFirestoreCouncilIntentStoreForTests(store);
  const intent = await createCouncilIntent(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      question: "Въпрос",
      recommendation: "Препоръка",
      rationale: "Причина",
    },
    { env, createId: () => "def67890" },
  );

  await assert.rejects(
    () =>
      consumeCouncilIntent(
        { ownerId: "owner-2", sessionId: "session-1", intentId: intent.id },
        { env },
      ),
    (error) => error.code === "COUNCIL_INTENT_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () =>
      consumeCouncilIntent(
        { ownerId: "owner-1", sessionId: "session-2", intentId: intent.id },
        { env },
      ),
    (error) =>
      error.code === "COUNCIL_INTENT_SESSION_MISMATCH" && error.status === 409,
  );
});
