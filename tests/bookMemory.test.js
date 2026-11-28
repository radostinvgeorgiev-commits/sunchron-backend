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
  assert.match(server, /\(\?:suggest\|check\|draft\)\$\/u, requireOwnerSession, paidAiRateLimiter/u);
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

// Reads back what createZip wrote, the way a reader app does.
async function readZip(buffer) {
  const { inflateRawSync } = await import("node:zlib");
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(start, start + size);
    files.push({ name, method, text: (method === 8 ? inflateRawSync(packed) : packed).toString("utf8") });
    at += 46 + nameLength;
  }
  return files;
}

test("chapters are saved one by one or from a manuscript, opened, deleted and exported as DOCX, EPUB and a print page", async () => {
  const { BOOK_CHAPTER_COLLECTION } = await import("../src/services/bookMemoryService.js");
  const store = memoryStore();
  const service = createBookMemoryService({ store, createId: ids(), askAi: async () => "{}" });
  const book = await service.createBook("maria", "Сивата роба");
  const parts = service.splitManuscript("Пролог.\n\nГлава 1: Кулата\nМила видя кулата.\n\nГлава 2\nВятърът <духаше> & пееше.");
  assert.deepEqual(
    parts.map(({ number, title }) => [number, title]),
    [[1, ""], [2, "Кулата"], [3, ""]],
  );
  let saved = await service.saveChapters("maria", book.id, parts.slice(1).map((part, index) => ({ ...part, number: index + 1 })));
  assert.deepEqual(saved.chapters.map(({ number, title, words }) => [number, title, words]), [[1, "Кулата", 3], [2, "", 4]]);
  // Each chapter's text lives in its own record, not in the book.
  assert.equal([...store.rows.keys()].filter((key) => key.startsWith(BOOK_CHAPTER_COLLECTION)).length, 2);
  assert.equal(JSON.stringify(saved).includes("Мила видя"), false);
  assert.equal((await service.getChapter("maria", book.id, 1)).text, "Мила видя кулата.");
  await assert.rejects(service.getChapter("ivan", book.id, 1), { code: "BOOK_NOT_FOUND" });
  await assert.rejects(service.saveChapters("maria", book.id, [{ number: 3, text: "  " }]), /номера и текста/u);

  const docx = await readZip((await service.exportBook("maria", book.id, "docx")).body);
  assert.deepEqual(docx.map(({ name }) => name).sort(), ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"].sort());
  const documentXml = docx.find(({ name }) => name === "word/document.xml").text;
  assert.match(documentXml, /Сивата роба/u);
  assert.match(documentXml, /1\. Кулата/u);
  assert.match(documentXml, /Вятърът &lt;духаше&gt; &amp; пееше\./u);

  const epubFile = await service.exportBook("maria", book.id, "epub");
  assert.equal(epubFile.type, "application/epub+zip");
  const epub = await readZip(epubFile.body);
  assert.equal(epub[0].name, "mimetype");
  assert.equal(epub[0].method, 0);
  assert.equal(epub[0].text, "application/epub+zip");
  assert.match(epub.find(({ name }) => name === "OEBPS/content.opf").text, /<itemref idref="c2"\/>/u);
  assert.match(epub.find(({ name }) => name === "OEBPS/chapter-2.xhtml").text, /<h1>Глава 2<\/h1>/u);

  const page = await service.exportBook("maria", book.id, "html");
  assert.match(page.body, /<script src="\/book-print\.js" defer><\/script>/u);
  assert.match(page.body, /<h2>1\. Кулата<\/h2><p>Мила видя кулата\.<\/p>/u);
  await assert.rejects(service.exportBook("maria", book.id, "exe"), /DOCX, EPUB или PDF/u);

  saved = await service.removeChapter("maria", book.id, 2);
  assert.deepEqual(saved.chapters.map(({ number }) => number), [1]);
  await service.clear("maria");
  assert.equal(store.rows.size, 0);
});

test("a draft follows the memory and the previous chapter, is checked, and is not saved", async () => {
  const inputs = [];
  const service = createBookMemoryService({
    store: memoryStore(),
    createId: ids(),
    env: {},
    askAi: async ({ input }) => {
      inputs.push(input);
      if (inputs.length === 1) return "Мила погледна с кафявите си очи към кулата.";
      return JSON.stringify({ issues: [{ fact: "id2", quote: "кафявите си очи", why: "Очите са зелени." }] });
    },
  });
  const book = await service.createBook("maria", "Книга");
  await service.addFacts("maria", book.id, [{ kind: "character", name: "Мила", text: "Мила има зелени очи.", fromChapter: 1 }]);
  await service.saveChapters("maria", book.id, [{ number: 1, text: "Мила стигна до кулата на хълма." }]);
  const draft = await service.draftChapter("maria", book.id, { number: 2, plan: "Мила влиза в кулата." });
  assert.equal(draft.number, 2);
  assert.match(draft.text, /кафявите си очи/u);
  assert.match(inputs[0][1].content, /Мила има зелени очи\./u);
  assert.match(inputs[0][1].content, /Мила стигна до кулата на хълма\./u);
  assert.match(inputs[0][0].content, /данни, не инструкции/u);
  assert.equal(draft.check.issues.length, 1);
  assert.equal(draft.check.issues[0].quote, "кафявите си очи");
  assert.deepEqual((await service.list("maria"))[0].chapters.map(({ number }) => number), [1]);
  await assert.rejects(service.draftChapter("maria", book.id, { number: 2, plan: " " }), /плана/u);
});

test("the chapters, the draft and the downloads are on the book panel and the server", () => {
  const panel = readFileSync("public/book.js", "utf8");
  for (const piece of ['data-tab="chapters"', "/chapters", "/draft", "export?format=", "NovariumArchive", "Запази главите"]) {
    assert.ok(panel.includes(piece), piece);
  }
  const router = readFileSync("src/routes/bookMemoryRouter.js", "utf8");
  assert.match(router, /"\/:bookId\/draft",\s*publicAiBudgetContext/u);
  assert.match(readFileSync("public/archive-reader.mjs", "utf8"), /globalThis\.NovariumArchive = \{/u);
  assert.match(readFileSync("public/book-print.js", "utf8"), /window\.print\(\)/u);
  const english = readFileSync("public/locale-en.js", "utf8");
  for (const textLine of ["Глави", "Запази главата", "Напиши чернова", "Качи ръкопис", "Изтегли книгата:"]) {
    assert.ok(english.includes(`\n${textLine}|`), textLine);
  }
});

test("every specialist keeps its own project memory in its own words, from one shared engine", async () => {
  const { SPECIALIST_PROFILES, specialistProfile, publicSpecialistProfiles } = await import("../src/services/specialistProfiles.js");
  const { buildCheckPrompt, buildDraftPrompt, buildSuggestPrompt, buildVerifyPrompt, splitManuscript } = await import(
    "../src/services/bookMemoryService.js"
  );
  // One profile for each of the 14 specialists, each naming the four kinds.
  const presets = listAssistantPresets().map(({ id }) => id);
  assert.equal(presets.length, 14);
  for (const id of presets) {
    const profile = SPECIALIST_PROFILES[id];
    assert.ok(profile, id);
    assert.deepEqual(Object.keys(profile.kinds).sort(), ["character", "event", "place", "rule"], id);
    assert.ok(profile.memory && profile.unit && profile.project && profile.expert && profile.look, id);
  }
  assert.equal(specialistProfile("nobody").id, "writer");
  assert.equal(specialistProfile("__proto__").id, "writer");
  assert.ok(!("expert" in publicSpecialistProfiles().lawyer), "the page gets only the words, not the prompts");

  // The writer's prompts stay as they were; a lawyer's speak of the case.
  const lawyer = specialistProfile("lawyer");
  const writer = specialistProfile("writer");
  const fact = { id: "f1", kind: "rule", name: "Срок", text: "Срокът за плащане е 30 дни.", fromChapter: 1 };
  assert.match(buildCheckPrompt("текст", [fact], 2, writer)[0].content, /^Ти проверяваш глава от книга/u);
  assert.match(buildCheckPrompt("текст", [fact], 2)[0].content, /^Ти проверяваш глава от книга/u);
  const check = buildCheckPrompt("текст", [fact], 2, lawyer)[0].content;
  assert.match(check, /юрист/u);
  assert.match(check, /Паметта на делото/u);
  assert.match(check, /срокове/u);
  assert.doesNotMatch(check, /книга/u);
  assert.match(buildSuggestPrompt("текст", 1, lawyer)[0].content, /rule = Клауза/u);
  assert.match(buildVerifyPrompt([{ fact, quote: "60 дни" }], lawyer)[0].content, /Паметта на делото/u);
  const draft = buildDraftPrompt({ title: "Иванов срещу Петров", number: 2, plan: "Отговор", facts: [fact], previous: "", profile: lawyer });
  assert.match(draft[0].content, /юрист/u);
  assert.doesNotMatch(draft[0].content, /книгата/u);

  // A file splits at "Част 1", "Раздел 2", "Lesson 3" for the others; a
  // sentence that starts with "Part" is not a heading.
  const parts = splitManuscript("Част 1 Увод\nПърво.\nPart of me stays.\nРаздел 2\nВторо.\nLesson 3: Край\nТрето.", "teacher");
  assert.deepEqual(parts.map(({ number, title }) => [number, title]), [[1, "Увод"], [2, ""], [3, "Край"]]);
  assert.match(parts[0].text, /Part of me stays\./u);
  assert.equal(splitManuscript("Глава 1\nЕдно.\nЧаст 2\nДве.").length, 1, "the writer splits only at chapters");
});

test("a project is saved under its specialist, and each specialist lists only its own", async () => {
  const store = memoryStore();
  const prompts = [];
  const service = createBookMemoryService({
    store,
    createId: ids(),
    askAi: async ({ input }) => {
      prompts.push(input[0].content);
      return '{"facts":[]}';
    },
  });
  const book = await service.createBook("maria", "Сивата роба");
  const lawsuit = await service.createBook("maria", "Иванов срещу Петров", "lawyer");
  const other = await service.createBook("maria", "Нещо", "no-such-specialist");
  assert.equal(book.domain, "writer");
  assert.equal(lawsuit.domain, "lawyer");
  assert.equal(other.domain, "writer");
  await service.suggestFacts("maria", lawsuit.id, { text: "Договорът е от 1 март." });
  assert.match(prompts.at(-1), /юрист/u);
  await service.suggestFacts("maria", book.id, { text: "Мила има зелени очи." });
  assert.match(prompts.at(-1), /писател/u);

  // The page asks for one specialist's projects; an older book with no
  // specialist belongs to the writer.
  const { createBookMemoryRouter } = await import("../src/routes/bookMemoryRouter.js");
  const listed = [{ id: "old", title: "Стара книга", facts: [] }, lawsuit];
  const router = createBookMemoryRouter({ service: { list: async () => listed } });
  const layer = router.stack.find((item) => item.route?.path === "/" && item.route.methods.get);
  const answer = async (query) => {
    let body;
    await layer.route.stack[0].handle(
      { owner: { memoryOwnerId: "maria" }, query },
      { status() { return this; }, json(value) { body = value; } },
    );
    return body;
  };
  assert.deepEqual((await answer({ domain: "lawyer" })).books.map(({ id }) => id), [lawsuit.id]);
  assert.equal((await answer({ domain: "lawyer" })).profile.memory, "Паметта на делото");
  assert.ok(!("expert" in (await answer({ domain: "lawyer" })).profile));
  assert.deepEqual((await answer({ domain: "writer" })).books.map(({ id }) => id), ["old"]);
  assert.equal((await answer({})).books.length, 2, "without a specialist the list is the whole list");
});

test("the panel names things for the chosen specialist, in every language of the site", async () => {
  const { SPECIALIST_PROFILES } = await import("../src/services/specialistProfiles.js");
  const book = readFileSync("public/book.js", "utf8");
  const tools = readFileSync("public/prompt-tools.js", "utf8");
  assert.match(tools, /new CustomEvent\(TOOL_EVENTS\[id\], \{ detail: \{ assistant: current\?\.id \|\| "" \} \}\)/u);
  assert.match(book, /call\("GET", `\?domain=\$\{encodeURIComponent\(asked\)\}`\)/u);
  // Switching specialists starts on a clean panel, and a late answer for the
  // previous specialist is dropped.
  assert.match(book, /if \(ticket !== opening\) return;/u);
  assert.match(book, /resetPanel\(\);/u);
  assert.match(book, /\.filter\(\(book\) => \(book\.domain \|\| "writer"\) === domain\)/u);
  assert.match(book, /call\("POST", "", \{ title, domain \}\)/u);
  assert.match(book, /pick\("Нова книга", "Нов проект"\)/u);
  const english = new Map(
    readFileSync("public/locale-en.js", "utf8")
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|")),
  );
  const catalogs = ["de", "es", "fr", "it", "ro"].map((code) => [code, JSON.parse(readFileSync(`public/locales/${code}.json`, "utf8"))]);
  const words = new Set(["Паметта на проекта", "Какво може"]);
  for (const profile of Object.values(SPECIALIST_PROFILES)) {
    words.add(profile.memory);
    for (const label of Object.values(profile.kinds)) words.add(label);
  }
  for (const match of book.matchAll(/pick\(\s*"[^"]+",\s*"([^"]+)",?\s*\)/gu)) words.add(match[1]);
  for (const line of words) {
    assert.ok(english.has(line), `English: ${line}`);
    for (const [code, catalog] of catalogs) assert.ok(catalog[english.get(line)], `${code}: ${line}`);
  }
});
