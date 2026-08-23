import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirestoreMemoryAdapter,
  FIRESTORE_SCHEMA_VERSION,
} from "../src/services/firestoreMemoryAdapter.js";
import {
  conversationMessageDocumentId,
  conversationSummaryDocumentId,
  profileMemoryDocumentId,
} from "../src/utils/memoryIdentifiers.js";

function clone(value) {
  return structuredClone(value);
}

function createSnapshot(ref, data) {
  return {
    exists: data !== undefined,
    id: ref.id,
    ref,
    data: () => (data === undefined ? undefined : clone(data)),
  };
}

function createFakeFirestore({ beforeSet } = {}) {
  const stores = new Map();
  let failTransaction = false;

  function storeFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function createReference(name, id) {
    const store = storeFor(name);
    return {
      id,
      path: `${name}/${id}`,
      async get() {
        return createSnapshot(this, store.get(id));
      },
      async set(data) {
        if (beforeSet) await beforeSet();
        store.set(id, clone(data));
      },
      async delete() {
        store.delete(id);
      },
    };
  }

  function createQuery(name, filters = [], ordering = [], maximum = null) {
    const query = {
      where(field, operator, value) {
        assert.equal(operator, "==");
        return createQuery(
          name,
          [...filters, { field, value }],
          ordering,
          maximum,
        );
      },
      orderBy(field, direction = "asc") {
        return createQuery(
          name,
          filters,
          [...ordering, { field, direction }],
          maximum,
        );
      },
      limit(value) {
        return createQuery(name, filters, ordering, value);
      },
      async get() {
        let documents = [...storeFor(name).entries()]
          .filter(([, data]) =>
            filters.every(({ field, value }) => data[field] === value),
          )
          .map(([id, data]) => createSnapshot(createReference(name, id), data));
        for (const { field, direction } of ordering.reverse()) {
          documents.sort((left, right) => {
            const leftValue = left.data()?.[field];
            const rightValue = right.data()?.[field];
            const leftTime =
              leftValue instanceof Date ? leftValue.getTime() : leftValue;
            const rightTime =
              rightValue instanceof Date ? rightValue.getTime() : rightValue;
            const comparison =
              leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
            return direction === "desc" ? -comparison : comparison;
          });
        }
        return {
          docs: maximum === null ? documents : documents.slice(0, maximum),
        };
      },
    };
    return query;
  }

  return {
    collection(name) {
      return {
        doc(id) {
          return createReference(name, id);
        },
        where(field, operator, value) {
          return createQuery(name).where(field, operator, value);
        },
      };
    },
    batch() {
      const operations = [];
      return {
        set(reference, data) {
          operations.push(() => reference.set(data));
        },
        delete(reference) {
          operations.push(() => reference.delete());
        },
        async commit() {
          for (const operation of operations) await operation();
        },
      };
    },
    async runTransaction(callback) {
      if (failTransaction) {
        const error = new Error("transaction failed");
        error.code = "FAKE_TRANSACTION_FAILED";
        throw error;
      }
      const operations = [];
      const transaction = {
        get(reference) {
          return reference.get();
        },
        set(reference, data) {
          operations.push(() => reference.set(data));
        },
        delete(reference) {
          operations.push(() => reference.delete());
        },
      };
      await callback(transaction);
      for (const operation of operations) await operation();
    },
    failNextTransaction() {
      failTransaction = true;
    },
  };
}

const config = {
  enabled: true,
  mode: "shadow",
  projectId: "synchron-shadow-test",
  databaseId: "synchron-shadow-v1",
  location: "europe-west1",
  collectionPrefix: "synchron-shadow-",
  emulatorHost: "127.0.0.1:8080",
  requestTimeoutMs: 500,
};

function profile(
  ownerId,
  fact,
  id = profileMemoryDocumentId(ownerId, "personal:fact:test"),
) {
  return {
    id,
    fact,
    normalizedFact: fact.toLocaleLowerCase("bg-BG"),
    memoryKey: "personal:fact:test",
    category: "personal-fact",
    scope: "personal",
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:01.000Z",
    source: "test",
  };
}

test("Firestore adapter preserves owner isolation and profile replacement", async () => {
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore(),
    config,
  });
  const first = await adapter.upsertProfileMemory({
    ownerId: "owner-a",
    memory: profile("owner-a", "стар факт"),
  });
  const replaced = await adapter.upsertProfileMemory({
    ownerId: "owner-a",
    memory: profile("owner-a", "нов факт"),
  });

  assert.equal(first.id, replaced.id);
  assert.equal(replaced.fact, "нов факт");
  assert.deepEqual(
    (await adapter.listProfileMemories({ ownerId: "owner-a" })).map(
      ({ fact }) => fact,
    ),
    ["нов факт"],
  );
  assert.deepEqual(
    await adapter.listProfileMemories({ ownerId: "owner-b" }),
    [],
  );
  assert.equal(
    await adapter.deleteProfileMemoryById({
      ownerId: "owner-b",
      id: first.id,
    }),
    false,
  );
  assert.equal(
    await adapter.deleteProfileMemoryById({
      ownerId: "owner-a",
      id: first.id,
    }),
    true,
  );
});

test("Firestore adapter writes an ordered idempotent conversation turn and summary", async () => {
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore(),
    config,
  });
  const createdAt = "2026-08-23T10:00:00.000Z";
  const input = {
    ownerId: "owner-a",
    sessionId: "shared-session",
    userText: "Как си?",
    replyText: "Добре съм.",
    turnId: "turn-1",
    createdAt,
  };

  await adapter.saveConversationTurn(input);
  await adapter.saveConversationTurn(input);

  assert.deepEqual(
    (
      await adapter.listConversationMessages({
        ownerId: "owner-a",
        sessionId: "shared-session",
      })
    ).map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Как си?" },
      { role: "assistant", content: "Добре съм." },
    ],
  );
  assert.deepEqual(
    await adapter.listConversationSummaries({ ownerId: "owner-a" }),
    [
      {
        sessionId: "shared-session",
        title: "Как си?",
        updatedAt: "2026-08-23T10:00:00.001Z",
        messageCount: 2,
      },
    ],
  );
  assert.equal(
    (await adapter.listConversationSummaries({ ownerId: "owner-b" })).length,
    0,
  );
  const otherOwnerTurn = await adapter.saveConversationTurn({
    ...input,
    ownerId: "owner-b",
  });
  assert.notEqual(
    otherOwnerTurn.messageIds[0],
    conversationMessageDocumentId("owner-a", "shared-session", "turn-1", "user"),
  );
  assert.match(
    conversationSummaryDocumentId("owner-a", "shared-session"),
    /^conversation-[a-f0-9]{64}$/u,
  );
});

test("Firestore adapter fails without partially committing a failed turn", async () => {
  const client = createFakeFirestore();
  const adapter = createFirestoreMemoryAdapter({ client, config });
  client.failNextTransaction();

  await assert.rejects(
    adapter.saveConversationTurn({
      ownerId: "owner-a",
      sessionId: "failed-session",
      userText: "Въпрос",
      replyText: "Отговор",
      turnId: "turn-failed",
    }),
    (error) => error.code === "FAKE_TRANSACTION_FAILED",
  );
  assert.deepEqual(
    await adapter.listConversationMessages({
      ownerId: "owner-a",
      sessionId: "failed-session",
    }),
    [],
  );
});

test("Firestore adapter keeps valid long memory keys usable for shadow deletes", async () => {
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore(),
    config,
  });
  const fact = "x".repeat(500);
  const memoryKey = `personal:fact:${fact}`;

  await adapter.upsertProfileMemory({
    ownerId: "owner-a",
    memory: {
      ...profile("owner-a", fact),
      memoryKey,
    },
  });

  assert.equal(
    (await adapter.listProfileMemories({ ownerId: "owner-a" }))[0].fact,
    fact,
  );
  assert.equal(
    await adapter.deleteProfileMemoryByFact({
      ownerId: "owner-a",
      memoryKey,
      normalizedFact: fact,
    }),
    1,
  );
});

test("Firestore adapter orders adjacent turns with the transaction sequence", async () => {
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore(),
    config,
  });
  const createdAt = "2026-08-23T10:00:00.000Z";

  await adapter.saveConversationTurn({
    ownerId: "owner-a",
    sessionId: "same-millisecond",
    userText: "Първи въпрос",
    replyText: "Първи отговор",
    turnId: "turn-1",
    createdAt,
  });
  await adapter.saveConversationTurn({
    ownerId: "owner-a",
    sessionId: "same-millisecond",
    userText: "Втори въпрос",
    replyText: "Втори отговор",
    turnId: "turn-2",
    createdAt,
  });

  assert.deepEqual(
    (
      await adapter.listConversationMessages({
        ownerId: "owner-a",
        sessionId: "same-millisecond",
      })
    ).map(({ content }) => content),
    ["Първи въпрос", "Първи отговор", "Втори въпрос", "Втори отговор"],
  );
});

test("Firestore adapter exposes the underlying settlement after a timeout", async () => {
  let releaseSet;
  const blockedSet = new Promise((resolve) => {
    releaseSet = resolve;
  });
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore({ beforeSet: () => blockedSet }),
    config,
    timeoutMs: 5,
  });
  let timeoutError;

  await assert.rejects(
    adapter.upsertProfileMemory({
      ownerId: "owner-a",
      memory: profile("owner-a", "забавен факт"),
    }),
    (error) => {
      timeoutError = error;
      return error.code === "FIRESTORE_PROFILE_WRITE_FAILED";
    },
  );
  assert.equal(typeof timeoutError.settlement?.then, "function");
  releaseSet();
  await timeoutError.settlement;
});

test("Firestore adapter exposes the versioned shadow schema", () => {
  const adapter = createFirestoreMemoryAdapter({
    client: createFakeFirestore(),
    config,
  });

  assert.equal(adapter.mode, "shadow");
  assert.equal(adapter.schemaVersion, FIRESTORE_SCHEMA_VERSION);
  assert.deepEqual(adapter.collections, {
    profiles: "synchron-shadow-profile-memories",
    messages: "synchron-shadow-conversation-messages",
    summaries: "synchron-shadow-conversation-summaries",
  });
});
