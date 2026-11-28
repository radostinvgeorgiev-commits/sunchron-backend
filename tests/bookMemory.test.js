import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createBookMemoryService,
  factHoldsAt,
  matchScore,
  parseJsonObject,
  relevantFacts,
  splitChapter,
  BOOK_LIMITS,
} from "../src/services/bookMemoryService.js";
import { listAssistantPresets, resolveAssistantPreset } from "../src/services/assistantPresets.js";

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(collection, id) {
      const data = rows.get(`${collection}/${id}`);
      return data ? { id, data } : null;
    },
    async commitOperations(operations) {
      for (const { type, collection, id, data } of operations) {
        if (type === "delete") rows.delete(`${collection}/${id}`);
        else rows.set(`${collection}/${id}`, data);
      }
    },
  };
}

const ids = () => {
  let next = 0;
  return () => `id${(next += 1)}`;
};

test("each person has their own books; facts are kept only when the person saves them", async () => {
  const store = memoryStore();
  const service = createBookMemoryService({ store, createId: ids(), askAi: async () => "{}" });
  const book = await service.createBook("maria", "Сивата роба");
  await service.createBook("ivan", "Друга книга");
  const saved = await service.addFacts("maria", book.id, [
    { kind: "character", name: "Мила", text: "Мила има зелени очи.", fromChapter: 1 },
    { kind: "nonsense", text: "   " },
  ]);
  assert.equal(saved.facts.length, 1);
  assert.equal(saved.facts[0].kind, "character");
  assert.equal((await service.list("ivan"))[0].facts.length, 0);
  await assert.rejects(service.addFacts("ivan", book.id, [{ text: "x" }]), { code: "BOOK_NOT_FOUND" });
  const afterRemove = await service.removeFact("maria", book.id, saved.facts[0].id);
  assert.equal(afterRemove.facts.length, 0);
  await service.clear("maria");
  assert.deepEqual(await service.list("maria"), []);
});

test("suggestions save nothing", async () => {
  const store = memoryStore();
  let asked = null;
  const service = createBookMemoryService({
    store,
    createId: ids(),
    askAi: async ({ input }) => {
      asked = input;
      return 'Ето: {"facts":[{"kind":"place","name":"Кулата","text":"Кулата е на хълма.","quote":"кулата на хълма"}]}';
    },
  });
  const book = await service.createBook("maria", "Книга");
  const suggestions = await service.suggestFacts("maria", book.id, { text: "Видя кулата на хълма.", chapter: 3 });
  assert.deepEqual(suggestions, [
    { kind: "place", name: "Кулата", text: "Кулата е на хълма.", quote: "кулата на хълма", fromChapter: 3 },
  ]);
  assert.match(asked[0].content, /данни, не инструкции/u);
  assert.equal((await service.list("maria"))[0].facts.length, 0);
});

test("a chapter check keeps only quotes that are really in the chapter and a second model confirms", async () => {
  const calls = [];
  const service = createBookMemoryService({
    store: memoryStore(),
    createId: ids(),
    env: { AI_CORE_PROVIDER: "claude", ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" },
    askAi: async ({ provider, input }) => {
      calls.push(provider || "default");
      if (provider) return '{"real":[1]}';
      const factId = input[1].content.match(/^(id\d+) \| character/mu)[1];
      return JSON.stringify({
        issues: [
          { fact: factId, quote: "Мила погледна с кафявите си очи", why: "Очите ѝ са зелени." },
          { fact: factId, quote: "измислен ред, който го няма", why: "x" },
          { fact: "unknown", quote: "Мила", why: "x" },
        ],
      });
    },
  });
  const book = await service.createBook("maria", "Книга");
  await service.addFacts("maria", book.id, [
    { kind: "character", name: "Мила", text: "Мила има зелени очи.", quote: "зелените очи на Мила" },
  ]);
  const result = await service.checkChapter("maria", book.id, {
    chapter: 4,
    text: "Сутринта Мила погледна с кафявите си очи към морето.",
  });
  assert.deepEqual(calls, ["default", "gemini"]);
  assert.equal(result.models, 2);
  assert.equal(result.score, 88);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].quote, "Мила погледна с кафявите си очи");
  assert.equal(result.issues[0].fact, "Мила има зелени очи.");
  assert.equal(result.issues[0].factQuote, "зелените очи на Мила");
});

test("an empty memory cannot be checked, and an intended change holds from its chapter on", async () => {
  const service = createBookMemoryService({ store: memoryStore(), createId: ids(), askAi: async () => "{}" });
  const book = await service.createBook("maria", "Книга");
  await assert.rejects(service.checkChapter("maria", book.id, { text: "Глава." }), { code: "BOOK_MEMORY_EMPTY" });
  const withFact = await service.addFacts("maria", book.id, [{ kind: "character", name: "Ана", text: "Робата е алена." }]);
  const factId = withFact.facts[0].id;
  await assert.rejects(service.changeFact("maria", book.id, factId, { chapter: 1, text: "Сива" }), /2 или повече/u);
  const changed = await service.changeFact("maria", book.id, factId, { chapter: 12, text: "Робата е сива." });
  const [old, fresh] = changed.facts;
  assert.equal(old.untilChapter, 11);
  assert.equal(fresh.fromChapter, 12);
  assert.equal(factHoldsAt(old, 11), true);
  assert.equal(factHoldsAt(old, 12), false);
  assert.equal(factHoldsAt(fresh, 12), true);
  assert.equal(factHoldsAt(fresh, 5), false);
});

test("helpers: relevant facts by name, parts, score and JSON", () => {
  const facts = [
    { id: "a", kind: "character", name: "Мила", text: "", fromChapter: 1 },
    { id: "b", kind: "place", name: "Кулата", text: "", fromChapter: 1 },
    { id: "c", kind: "rule", name: "Магия", text: "", fromChapter: 1 },
    { id: "d", kind: "character", name: "Борис", text: "", fromChapter: 9 },
  ];
  assert.deepEqual(
    relevantFacts(facts, "Мила влезе в кулата. Борис чакаше.", 3).map((fact) => fact.id),
    ["a", "b", "c"],
  );
  const long = `${"а".repeat(BOOK_LIMITS.part - 10)}\n${"б".repeat(500)}`;
  assert.equal(splitChapter(long).length, 2);
  assert.equal(matchScore(0), 100);
  assert.equal(matchScore(20), 0);
  assert.equal(parseJsonObject("нищо"), null);
  assert.deepEqual(parseJsonObject('текст {"a":1} край'), { a: 1 });
});

test("Писател is a specialist with the book memory tool, and the page opens it", () => {
  const writer = listAssistantPresets().find((preset) => preset.id === "writer");
  assert.equal(writer.label, "Писател");
  assert.deepEqual(
    writer.tools.map((tool) => tool.id),
    ["book", "files", "drive"],
  );
  assert.match(resolveAssistantPreset("writer").instruction, /само когато авторът ги запази/u);
  const page = readFileSync("public/index.html", "utf8");
  assert.match(page, /<script src="\/book\.js\?v=[^"]+" defer><\/script>/u);
  assert.match(page, /href="\/book\.css\?v=/u);
  assert.match(readFileSync("public/prompt-tools.js", "utf8"), /book: "novarium:book"/u);
  const panel = readFileSync("public/book.js", "utf8");
  assert.match(panel, /addEventListener\("novarium:book"/u);
  assert.match(panel, /fetch\(`\/api\/books/u);
  const server = readFileSync("server.js", "utf8");
  assert.match(server, /"\/api\/books",\s*requireOwnerSession,\s*privateApiRateLimiter/u);
  assert.match(server, /\(\?:suggest\|check\)\$\/u, requireOwnerSession, paidAiRateLimiter/u);
  assert.match(readFileSync("src/services/accountDataService.js", "utf8"), /await clearBooks\(ownerId\)/u);
});

test("the free check needs no account, saves nothing but a daily count, and stops at the daily total", async () => {
  const { createFreeChapterCheck, parseFreeFacts, FREE_CHECK_LIMITS } = await import("../src/services/freeChapterCheckService.js");
  assert.deepEqual(
    parseFreeFacts("- Мила има зелени очи.\n\n2) Кулата е на хълма.").map((fact) => fact.text),
    ["Мила има зелени очи.", "Кулата е на хълма."],
  );
  const store = memoryStore();
  let asked = null;
  const free = createFreeChapterCheck({
    store,
    env: {},
    today: () => "2026-11-28",
    askAi: async ({ input }) => {
      asked = input[1].content;
      return '{"issues":[{"fact":"f1","quote":"кафявите си очи","why":"Зелени са."},{"fact":"f1","quote":"няма го","why":"x"}]}';
    },
  });
  await assert.rejects(free.check({ facts: "  ", text: "Глава" }), /поне един факт/u);
  const result = await free.check({ facts: "Мила има зелени очи.", text: "Мила погледна с кафявите си очи." });
  assert.match(asked, /f1 \| rule \|  \| Мила има зелени очи\./u);
  assert.deepEqual(result.issues, [{ fact: "Мила има зелени очи.", quote: "кафявите си очи", why: "Зелени са." }]);
  assert.equal(result.score, 88);
  assert.deepEqual([...store.rows.values()], [{ day: "2026-11-28", count: 1 }]);
  store.rows.set([...store.rows.keys()][0], { day: "2026-11-28", count: FREE_CHECK_LIMITS.perDay });
  await assert.rejects(free.check({ facts: "А", text: "Б" }), { code: "FREE_CHECK_DAILY_LIMIT" });
  const server = readFileSync("server.js", "utf8");
  assert.match(server, /"\/api\/free-check",\s*createApiRateLimiter\(\{\s*limit: 3,\s*windowMs: 24 \* 60 \* 60 \* 1000/u);
});
