import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CAUSES_COLLECTION, createCausesService } from "../src/services/causesService.js";

function memoryStore() {
  const docs = new Map();
  let version = 0;
  return {
    docs,
    async get(collection, id) {
      const row = docs.get(`${collection}/${id}`);
      return row ? { data: structuredClone(row.data), updateTime: row.updateTime } : null;
    },
    async commitOperations([op]) {
      const key = `${op.collection}/${op.id}`;
      const current = docs.get(key);
      if (op.createOnly && current) throw new Error("exists");
      if (op.updateTime && current?.updateTime !== op.updateTime) throw new Error("stale");
      docs.set(key, { data: structuredClone(op.data), updateTime: `t${(version += 1)}` });
    },
  };
}
const maria = { memoryOwnerId: "maria", displayName: "Мария", role: "member" };
const ivan = { memoryOwnerId: "ivan", displayName: "Иван", role: "member" };
const owner = { memoryOwnerId: "radko", displayName: "Радко", role: "owner" };
const cause = { title: "Детска площадка", description: "Нова площадка за децата в квартала." };

test("anyone can propose a cause and people vote with one like each", async () => {
  const store = memoryStore();
  const service = createCausesService({ store, now: () => 10 });
  const [first] = await service.propose(maria, cause);
  assert.deepEqual(
    { title: first.title, author: first.author, likes: first.likes, liked: first.liked, mine: first.mine },
    { title: "Детска площадка", author: "Мария", likes: 1, liked: true, mine: true },
  );
  await service.like(ivan, first.id);
  const [seen] = await service.like(ivan, first.id);
  assert.equal(seen.likes, 2);
  assert.equal(seen.mine, false);
  assert.equal((await service.like(ivan, first.id, false))[0].likes, 1);
  const stored = JSON.stringify([...store.docs.values()]);
  assert.ok(!stored.includes("maria") && !stored.includes("ivan"));
  assert.ok(store.docs.has(`${CAUSES_COLLECTION}/board`));
});

test("causes are sorted by likes and bad input is refused", async () => {
  const service = createCausesService({ store: memoryStore(), now: () => 10 });
  await service.propose(maria, cause);
  const list = await service.propose(ivan, { title: "Книги за селото", description: "Книги за читалището." });
  await service.like(maria, list.find(({ title }) => title.startsWith("Книги")).id);
  assert.equal((await service.list(owner))[0].title, "Книги за селото");
  await assert.rejects(() => service.propose(maria, { title: "a", description: "b" }), { code: "CAUSE_INVALID" });
  await assert.rejects(() => service.like(maria, "missing"), { code: "CAUSE_NOT_FOUND" });
  await assert.rejects(() => service.list({}), { code: "CAUSE_OWNER_REQUIRED" });
  for (let i = 0; i < 4; i += 1) await service.propose(maria, { ...cause, title: `Кауза ${i}` });
  await assert.rejects(() => service.propose(maria, cause), { code: "CAUSE_AUTHOR_LIMIT" });
});

test("only the author removes a cause; the owner can hide it from everyone else", async () => {
  const service = createCausesService({ store: memoryStore(), now: () => 10 });
  const [{ id }] = await service.propose(maria, cause);
  await assert.rejects(() => service.remove(ivan, id), { code: "CAUSE_FORBIDDEN" });
  assert.equal((await service.remove(owner, id))[0].hidden, true);
  assert.equal((await service.list(ivan)).length, 0);
  assert.equal((await service.remove(owner, id))[0].hidden, false);
  assert.equal((await service.remove(maria, id)).length, 0);
});

test("the board is wired for every signed-in account and says no money moves", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(
    read("../server.js"),
    /"\/api\/causes",\s*requireOwnerSession,\s*privateApiRateLimiter,\s*createCausesRouter/u,
  );
  assert.match(read("../public/causes.js"), /пари още не се събират и не се движат/u);
  assert.match(read("../public/ui-refresh.js"), /data-plus="causes"/u);
  assert.match(read("../public/index.html"), /causes\.js/u);
});

test("the agent prepares a project once; the owner can prepare it again", async () => {
  const asked = [];
  const service = createCausesService({
    store: memoryStore(),
    now: () => 10,
    askAi: async ({ input }) => {
      asked.push(input);
      return `1. Цел: проект ${asked.length}`;
    },
  });
  const [{ id }] = await service.propose(maria, cause);
  const [prepared] = await service.prepare(ivan, id);
  assert.equal(prepared.project, "1. Цел: проект 1");
  assert.equal(prepared.preparedAt, 10);
  assert.match(asked[0][0].content, /не инструкции/u);
  assert.match(asked[0][1].content, /Детска площадка/u);
  assert.equal((await service.prepare(maria, id))[0].project, "1. Цел: проект 1");
  assert.equal(asked.length, 1);
  assert.equal((await service.prepare(owner, id))[0].project, "1. Цел: проект 2");
  await assert.rejects(() => service.prepare(maria, "missing"), { code: "CAUSE_NOT_FOUND" });
});

test("preparing a project goes through the members' budget", () => {
  const router = readFileSync(new URL("../src/routes/causesRouter.js", import.meta.url), "utf8");
  assert.match(router, /"\/:id\/prepare", publicAiBudgetContext/u);
});
