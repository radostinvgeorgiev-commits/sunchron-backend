import assert from "node:assert/strict";
import test from "node:test";

import { setOpenSearchClientForTests } from "../src/config/opensearch.js";
import {
  buildMemoryContext,
  deleteProfileMemoryByFact,
  listConversationMessages,
  listProfileMemories,
  profileMemoryDocumentId,
  saveConversationTurn,
  saveProfileMemory,
} from "../src/services/memoryService.js";

function createMemoryClient() {
  const profile = new Map();
  const conversations = new Map();
  const operations = [];

  function documents(index) {
    return index.includes("conversation") ? conversations : profile;
  }

  function matches(source, filter = []) {
    return filter.every((item) => {
      if (item.term) {
        const [field, expected] = Object.entries(item.term)[0];
        return source[field] === expected;
      }
      if (item.terms) {
        const [field, expected] = Object.entries(item.terms)[0];
        return expected.includes(source[field]);
      }
      return true;
    });
  }

  return {
    indices: {
      exists: async () => ({ body: true }),
      putMapping: async () => ({ body: { acknowledged: true } }),
    },
    async search({ index, body }) {
      const items = [...documents(index).entries()].map(([id, source]) => ({
        _id: id,
        _source: source,
      }));
      const filters =
        body.query?.bool?.filter || (body.query?.term ? [body.query] : []);
      const filtered = items
        .filter(({ _source }) => matches(_source, filters))
        .sort((left, right) =>
          String(
            right._source.updatedAt || right._source.createdAt,
          ).localeCompare(
            String(left._source.updatedAt || left._source.createdAt),
          ),
        );
      return { body: { hits: { hits: filtered.slice(0, body.size || 200) } } };
    },
    async index({ index, id, body }) {
      operations.push({ type: "index", id });
      documents(index).set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async bulk({ body }) {
      operations.push({ type: "bulk" });
      for (let index = 0; index < body.length; index += 1) {
        const operation = body[index];
        if (operation.delete) {
          documents(operation.delete._index).delete(operation.delete._id);
          continue;
        }
        if (operation.index) {
          documents(operation.index._index).set(
            operation.index._id,
            structuredClone(body[index + 1]),
          );
          index += 1;
        }
      }
      return { body: { errors: false } };
    },
    async deleteByQuery({ index, body }) {
      const filters = body.query?.bool?.filter || [];
      let deleted = 0;
      for (const [id, source] of documents(index)) {
        const comparable = { ...source, _id: id };
        if (matches(comparable, filters)) {
          documents(index).delete(id);
          deleted += 1;
        }
      }
      return { body: { deleted } };
    },
    seedProfile(id, source) {
      profile.set(id, structuredClone(source));
    },
    profileFor(ownerId) {
      return [...profile.entries()]
        .filter(([, memory]) => memory.ownerId === ownerId)
        .map(([id, memory]) => ({ id, ...memory }));
    },
    operations,
  };
}

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
  setOpenSearchClientForTests(client);
  const ownerId = "owner-a";

  client.seedProfile("legacy-code", {
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
  assert.deepEqual(
    client.operations.map(({ type }) => type),
    ["index", "bulk"],
  );

  const memories = await listProfileMemories({
    scope: "personal",
    ownerId,
  });
  const context = buildMemoryContext(memories);

  assert.match(context, /KAMCHIA-7429/u);
  assert.doesNotMatch(context, /МОРСКИ ФАР 728/u);
  assert.equal(client.profileFor(ownerId).length, 1);

  const freshSession = await listConversationMessages(
    "brand-new-session",
    20,
    ownerId,
  );
  assert.deepEqual(freshSession, []);
});

test("concurrent writes for one owner and topic leave one raw document", async () => {
  const client = createMemoryClient();
  const originalSearch = client.search.bind(client);
  let waitingSearches = 0;
  let releaseSearches;
  const bothSearchesStarted = new Promise((resolve) => {
    releaseSearches = resolve;
  });
  client.search = async (input) => {
    const result = await originalSearch(input);
    if (input.index.includes("profile")) {
      waitingSearches += 1;
      if (waitingSearches === 2) releaseSearches();
      await bothSearchesStarted;
    }
    return result;
  };
  setOpenSearchClientForTests(client);
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
  assert.equal(client.profileFor(ownerId).length, 1);
  assert.match(client.profileFor(ownerId)[0].fact, /син|зелен/u);
});

test("failed stable index never deletes the legacy document", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-index-failure";
  client.seedProfile("legacy-color", {
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
  client.index = async () => {
    throw new Error("index unavailable");
  };
  setOpenSearchClientForTests(client);

  await assert.rejects(
    () =>
      saveProfileMemory(
        "Любимият ми цвят е зелен",
        "failure-test",
        "personal",
        ownerId,
      ),
    /index unavailable/u,
  );

  assert.equal(client.profileFor(ownerId).length, 1);
  assert.equal(client.profileFor(ownerId)[0].id, "legacy-color");
  assert.deepEqual(client.operations, []);
});

test("cleanup failure keeps the new stable document available", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-cleanup-failure";
  client.seedProfile("legacy-color", {
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
  client.bulk = async () => {
    throw new Error("cleanup unavailable");
  };
  setOpenSearchClientForTests(client);

  const saved = await saveProfileMemory(
    "Любимият ми цвят е зелен",
    "failure-test",
    "personal",
    ownerId,
  );
  const visible = await listProfileMemories({ scope: "personal", ownerId });

  assert.equal(saved.cleanupCompleted, false);
  assert.equal(client.profileFor(ownerId).length, 2);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].fact, "Любимият ми цвят е зелен");
});

test("partial bulk cleanup is reported without hiding the new document", async () => {
  const client = createMemoryClient();
  const ownerId = "owner-partial-cleanup";
  client.seedProfile("legacy-color", {
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
  client.bulk = async () => ({ body: { errors: true } });
  setOpenSearchClientForTests(client);

  const saved = await saveProfileMemory(
    "Любимият ми цвят е зелен",
    "failure-test",
    "personal",
    ownerId,
  );
  const visible = await listProfileMemories({ scope: "personal", ownerId });

  assert.equal(saved.cleanupCompleted, false);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].fact, "Любимият ми цвят е зелен");
});

test("user A never reads user B profile or conversation memory", async () => {
  const client = createMemoryClient();
  setOpenSearchClientForTests(client);

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
  setOpenSearchClientForTests(client);
  const ownerId = "owner-exact-delete";
  const fact = "Любимият ми цвят е син";

  await saveProfileMemory(fact, "integration-test", "personal", ownerId);

  const deleted = await deleteProfileMemoryByFact(fact, "personal", ownerId);

  assert.equal(deleted, 1);
  assert.deepEqual(client.profileFor(ownerId), []);
});

test("old fact from the same topic never deletes the current fact", async () => {
  const client = createMemoryClient();
  setOpenSearchClientForTests(client);
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
    client.profileFor(ownerId).map(({ fact }) => fact),
    ["Любимият ми цвят е син"],
  );
});

test("different normalized fact with the same memory key is preserved", async () => {
  const client = createMemoryClient();
  setOpenSearchClientForTests(client);
  const ownerId = "owner-same-key-delete";

  client.seedProfile("current-color", {
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
  assert.equal(client.profileFor(ownerId).length, 1);
  assert.equal(client.profileFor(ownerId)[0].fact, "Любимият ми цвят е син");
});
