import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeContext,
  createInMemoryKnowledgeStore,
  saveApprovedKnowledgeItems,
  setFirestoreKnowledgeStoreForTests,
  listApprovedKnowledge,
} from "../src/services/knowledgeService.js";

test.afterEach(() => setFirestoreKnowledgeStoreForTests(null));

test("approved knowledge is owner-scoped and appears in bounded context", async () => {
  const store = createInMemoryKnowledgeStore();
  setFirestoreKnowledgeStoreForTests(store);
  await saveApprovedKnowledgeItems({
    ownerId: "owner-a",
    items: [{ id: "a", text: "Проектът започва със здраве и тренировки.", scope: "project", category: "fact", sourceId: "chat-1", sourceTitle: "Основата" }],
  });
  await saveApprovedKnowledgeItems({
    ownerId: "owner-b",
    items: [{ id: "b", text: "Чуждо знание.", scope: "project", category: "fact", sourceId: "chat-2", sourceTitle: "Друг" }],
  });

  const items = await listApprovedKnowledge({ ownerId: "owner-a" });
  assert.equal(items.length, 1);
  assert.match(buildKnowledgeContext(items), /здраве и тренировки/u);
  assert.doesNotMatch(buildKnowledgeContext(items), /Чуждо/u);
});

test("knowledge context is empty when nothing is approved", () => {
  assert.equal(buildKnowledgeContext([]), "");
});
