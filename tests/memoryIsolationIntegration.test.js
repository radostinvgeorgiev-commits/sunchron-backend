import assert from "node:assert/strict";
import test from "node:test";

import { setOpenSearchClientForTests } from "../src/config/opensearch.js";
import {
  buildMemoryContext,
  deleteProfileMemoryByFact,
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
  saveProfileMemory,
} from "../src/services/memoryService.js";

function createMemoryClient() {
  const profile = new Map();
  const conversations = new Map();

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
      documents(index).set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async bulk({ body }) {
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
      return [...profile.values()].filter(
        (memory) => memory.ownerId === ownerId,
      );
    },
  };
}

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
