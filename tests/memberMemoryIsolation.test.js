import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContext,
  listProfileMemories,
  setFirestoreMemoryStoreForTests,
} from "../src/services/memoryService.js";
import { PROJECT_DEFINITION } from "../src/config/projectIdentity.js";

function useStore(t, documents) {
  const keys = ["MEMORY_BACKEND", "PERSISTENCE_BACKEND"];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "firestore";
  setFirestoreMemoryStoreForTests({
    listProfileDocuments: async (ownerId) =>
      documents.filter((document) => document.data.ownerId === ownerId),
  });
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    setFirestoreMemoryStoreForTests(null);
  });
}

test("a customer's memory never contains the AI CORE product definition", async (t) => {
  useStore(t, []);
  assert.deepEqual(await listProfileMemories({ ownerId: "identity-platform:customer" }), []);
  assert.deepEqual(
    await listProfileMemories({ ownerId: "identity-platform:customer", scope: "project" }),
    [],
  );
  const owner = await listProfileMemories({ ownerId: "primary-user" });
  assert.ok(owner.some((memory) => memory.source === "system-canonical"));
});

test("the AI context for customers leaves out the product definition", () => {
  const memories = [{ fact: "Обичам кафе", scope: "personal" }];
  assert.doesNotMatch(
    buildMemoryContext(memories, { personName: "Ива", includeProjectIdentity: false }),
    new RegExp(PROJECT_DEFINITION.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assert.match(
    buildMemoryContext(memories),
    new RegExp(PROJECT_DEFINITION.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
});
