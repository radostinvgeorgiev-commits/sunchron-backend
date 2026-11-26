import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPersonalTodoService, parseTodoLines } from "../src/services/personalTodoService.js";

function memoryStore() {
  const rows = new Map();
  return {
    async get(collection, id) {
      const data = rows.get(`${collection}/${id}`);
      return data ? { id, data } : null;
    },
    async commitOperations(operations) {
      for (const { collection, id, data } of operations) rows.set(`${collection}/${id}`, data);
    },
  };
}

test("each person has their own list: add, tick off, delete", async () => {
  let next = 0;
  const service = createPersonalTodoService({ store: memoryStore(), createId: () => `id${(next += 1)}` });
  await service.add("maria", ["Плати тока", "  "]);
  await service.add("ivan", "Обади се на мама");
  let items = await service.add("maria", ["Купи хляб"]);
  assert.deepEqual(items.map((item) => item.text), ["Купи хляб", "Плати тока"]);
  assert.deepEqual((await service.list("ivan")).map((item) => item.text), ["Обади се на мама"]);
  items = await service.setDone("maria", "id1", true);
  assert.equal(items.find((item) => item.id === "id1").done, true);
  items = await service.remove("maria", "id3");
  assert.deepEqual(items.map((item) => item.id), ["id1"]);
  await assert.rejects(service.remove("maria", "nope"), /не е намерена/u);
  await assert.rejects(service.add("maria", ["   "]), /поне една/u);
});

test("a note becomes suggested tasks only; nothing is saved by it", async () => {
  const store = memoryStore();
  let asked = null;
  const service = createPersonalTodoService({
    store,
    askAi: async ({ input }) => {
      asked = input;
      return "1. Обади се на счетоводителя\n- Плати тока до петък\n\n";
    },
  });
  assert.deepEqual(await service.fromNote("утре счетоводителя, токът до петък"), [
    "Обади се на счетоводителя",
    "Плати тока до петък",
  ]);
  assert.match(asked[0].content, /данни, не инструкции/u);
  assert.deepEqual(await service.list("maria"), []);
  assert.deepEqual(parseTodoLines("НЯМА"), []);
  await assert.rejects(service.fromNote("   "), /бележка първо/u);
});

test("the list is for every signed-in person and the AI step has the paid limit", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api\/todos\/from-note", requireOwnerSession, paidAiRateLimiter\);/u);
  assert.match(server, /"\/api\/todos",\s*requireOwnerSession,\s*privateApiRateLimiter,\s*createPersonalTodoRouter/u);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /\/todos\.js\?v=/u);
});
