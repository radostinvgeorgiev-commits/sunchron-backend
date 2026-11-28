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

test("every other specialist's check sends all facts that hold, so an allergy is checked without its name", async () => {
  const sent = [];
  const checks = [];
  const service = createBookMemoryService({
    store: memoryStore(),
    createId: ids(),
    askAi: async ({ input }) => {
      sent.push(input[1].content);
      if (/"issues"/u.test(input[0].content)) checks.push(input[1].content);
      return /"issues"/u.test(input[0].content) ? '{"issues":[]}' : "Баклава с орехи за неделя.";
    },
  });
  // The chef keeps an allergy as kind "place" (Алергия); the recipe never
  // says "ядки", it says "орехи".
  const kitchen = await service.createBook("maria", "Кухнята", "chef");
  await service.addFacts("maria", kitchen.id, [{ kind: "place", name: "Ядки", text: "Детето е алергично към ядки." }]);
  await service.checkChapter("maria", kitchen.id, { text: "Баклава с орехи и мед. Смели 200 г орехи." });
  assert.equal(sent.length, 1, "the allergy reached the check");
  assert.match(sent[0], /алергично към ядки/u);
  assert.match(sent[0], /\| Алергия \|/u, "the memory line names the chef's kind");
  // The draft is checked the same way: its check gets the allergy too,
  // though the draft never says "ядки".
  sent.length = 0;
  checks.length = 0;
  const draft = await service.draftChapter("maria", kitchen.id, { number: 1, plan: "Сладкиш за неделя." });
  assert.equal(draft.text, "Баклава с орехи за неделя.");
  assert.equal(checks.length, 1, "the draft was checked");
  assert.match(checks[0], /алергично към ядки/u, "the draft check saw the allergy");
  assert.match(checks[0], /\[ГЛАВА\]\nБаклава с орехи за неделя\.\n/u, "and it checked the draft");
  // The writer is as before: a hero the chapter does not name is not sent.
  sent.length = 0;
  const book = await service.createBook("maria", "Книга");
  await service.addFacts("maria", book.id, [{ kind: "character", name: "Мила", text: "Мила има зелени очи." }]);
  const result = await service.checkChapter("maria", book.id, { text: "Иван отиде до морето." });
  assert.equal(sent.length, 0);
  assert.equal(result.score, 100);
});

test("past 80 facts an allergy, a doctor's instruction and a medicine still reach the check and the draft", async () => {
  const sent = [];
  const service = createBookMemoryService({
    store: memoryStore(),
    createId: ids(),
    askAi: async ({ input }) => {
      sent.push(input.map((line) => line.content).join("\n"));
      return /"issues"/u.test(input[0].content) ? '{"issues":[]}' : "Днес пих лекарството.";
    },
  });
  // 85 test values first, then the allergy: saved last, it is still sent.
  const diary = await service.createBook("maria", "Дневник", "doctor");
  const values = Array.from({ length: 85 }, (_, index) => ({ kind: "event", name: `Изследване ${index + 1}`, text: `Хемоглобин ${120 + index} g/L.` }));
  await service.addFacts("maria", diary.id, values);
  await service.addFacts("maria", diary.id, [{ kind: "place", name: "Пеницилин", text: "Алергия към пеницилин: обрив и задух." }]);
  await service.checkChapter("maria", diary.id, { text: "Днес лекарят ми предписа амоксицилин 500 мг три пъти дневно." });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Алергия към пеницилин/u);
  sent.length = 0;
  await service.draftChapter("maria", diary.id, { number: 1, plan: "Какво пих днес." });
  assert.match(sent[0], /Алергия към пеницилин/u, "the draft's own facts hold the allergy");
  assert.equal(sent.length, 2, "the draft was checked");
  assert.match(sent[1], /"issues"/u);
  assert.match(sent[1], /Алергия към пеницилин/u, "and so does the draft's check");
  // The chef's nut allergy after 85 products, the same way.
  sent.length = 0;
  const kitchen = await service.createBook("maria", "Кухня", "chef");
  await service.addFacts("maria", kitchen.id, Array.from({ length: 85 }, (_, index) => ({ kind: "character", name: `Продукт ${index + 1}`, text: `В хладилника има продукт ${index + 1}.` })));
  await service.addFacts("maria", kitchen.id, [{ kind: "place", name: "Ядки", text: "Детето е алергично към ядки." }]);
  await service.checkChapter("maria", kitchen.id, { text: "Добави 2 с.л. бадемово масло към соса." });
  assert.match(sent[0], /алергично към ядки/u);
  // Never more than 80 facts in one check.
  const { holdingFacts } = await import("../src/services/bookMemoryService.js");
  const facts = (await service.list("maria")).find((book) => book.id === diary.id).facts;
  const picked = holdingFacts(facts, "текст", 1, ["place", "rule", "character"]);
  assert.equal(picked.length, BOOK_LIMITS.factsPerCheck);
  assert.equal(picked[0].name, "Пеницилин");
  assert.equal(new Set(picked).size, picked.length, "no fact twice");
});

test("one record holds every project's facts, so it stops growing before Firestore's 1 MiB, and a delete still works", async () => {
  const store = memoryStore();
  const service = createBookMemoryService({ store, createId: ids() });
  const { RECORD_BYTES } = await import("../src/services/bookMemoryService.js");
  assert.ok(RECORD_BYTES < 1024 * 1024 - 64 * 1024);
  // Full-length facts in Cyrillic, 50 at a time, until the memory says it is full.
  const long = (length, seed) => `${seed} ${"дълъг текст ".repeat(length)}`.slice(0, length);
  const fact = (index) => ({ kind: "event", name: long(80, `Име ${index}`), text: long(400, `Факт ${index}`), quote: long(300, `Цитат ${index}`) });
  let full = null;
  let made = 0;
  for (let project = 0; project < 4 && !full; project += 1) {
    const book = await service.createBook("maria", `Дело ${project + 1}`, "lawyer");
    for (let batch = 0; batch < 8 && !full; batch += 1) {
      try {
        await service.addFacts("maria", book.id, Array.from({ length: 50 }, () => fact((made += 1))));
      } catch (error) {
        full = error;
      }
    }
  }
  assert.equal(full?.code, "BOOK_MEMORY_FULL");
  assert.equal(full.status, 409);
  assert.equal(full.message, "Паметта е пълна. Изтрий проект или факти, които вече не ти трябват.");
  const record = [...store.rows.values()].find((data) => Array.isArray(data?.books));
  const bytes = Buffer.byteLength(JSON.stringify(record));
  assert.ok(bytes < 1024 * 1024, `${bytes} bytes`);
  // A delete always goes through, and then there is room again.
  const [first] = record.books;
  await service.removeFact("maria", first.id, first.facts[0].id);
  await service.removeBook("maria", first.id);
  const room = await service.createBook("maria", "Ново дело", "lawyer");
  await service.addFacts("maria", room.id, [{ kind: "event", text: "Нов кратък факт." }]);
});

test("each specialist keeps up to 20 projects of its own, 60 in all, with its own words", async () => {
  const service = createBookMemoryService({ store: memoryStore(), createId: ids() });
  for (let index = 0; index < BOOK_LIMITS.books; index += 1) await service.createBook("ana", `Книга ${index}`);
  await assert.rejects(service.createBook("ana", "Още една"), { code: "BOOK_LIST_FULL", message: /книги/u });
  // The writer's 20 books do not take the lawyer's place.
  assert.equal((await service.createBook("ana", "Дело 0", "lawyer")).domain, "lawyer");
  for (let index = 1; index < BOOK_LIMITS.books; index += 1) await service.createBook("ana", `Дело ${index}`, "lawyer");
  await assert.rejects(service.createBook("ana", "Още едно", "lawyer"), { code: "BOOK_LIST_FULL", message: /проекти при този специалист/u });
  for (let index = 0; index < BOOK_LIMITS.books; index += 1) await service.createBook("ana", `Курс ${index}`, "teacher");
  assert.equal(BOOK_LIMITS.projects, 3 * BOOK_LIMITS.books);
  await assert.rejects(service.createBook("ana", "Рецепта", "chef"), { code: "BOOK_PROJECTS_FULL", message: /всички специалисти/u });
  await assert.rejects(service.createBook("ana", "", "chef"), { message: "Напиши името на проекта." });
  await assert.rejects(service.createBook("ana", ""), { message: "Напиши името на книгата." });
});

test("the doctor, the listener, the coach and the chef keep their safety rules in the memory too", async () => {
  const { SPECIALIST_PROFILES, specialistProfile, publicSpecialistProfile, publicSpecialistProfiles } = await import(
    "../src/services/specialistProfiles.js"
  );
  const { buildCheckPrompt, buildDraftPrompt, buildSuggestPrompt } = await import("../src/services/bookMemoryService.js");
  const doctor = specialistProfile("doctor");
  const fact = { id: "f1", kind: "place", name: "Пеницилин", text: "Алергия към пеницилин.", fromChapter: 1 };
  const draft = buildDraftPrompt({ title: "Дневник", number: 3, plan: "Болка в гърдите от сутринта.", facts: [fact], previous: "", profile: doctor })[0].content;
  assert.match(draft, /не поставяй диагноза/u);
  assert.match(draft, /започни текста с „Обади се веднага на 112\.“/u);
  assert.match(draft, /освен предупреждението по-долу/u);
  assert.match(buildCheckPrompt("текст", [fact], 2, doctor)[0].content, /не поставяй диагноза/u);
  assert.match(buildSuggestPrompt("текст", 1, specialistProfile("listener"))[0].content, /Не си психолог/u);
  assert.match(buildDraftPrompt({ title: "План", number: 1, plan: "Болка в коляното.", facts: [], previous: "", profile: specialistProfile("coach") })[0].content, /Първо говори с лекар/u);
  assert.match(buildDraftPrompt({ title: "Кухня", number: 1, plan: "Обяд.", facts: [], previous: "", profile: specialistProfile("chef") })[0].content, /алергия или непоносимост/u);
  // The writer's and the lawyer's prompts carry none of it.
  for (const id of ["writer", "lawyer"]) {
    const words = buildDraftPrompt({ title: "Т", number: 1, plan: "П", facts: [], previous: "", profile: specialistProfile(id) })[0].content;
    assert.doesNotMatch(words, /112|предупреждението/u, id);
  }
  // The person sees a note under the heading; the page never gets the rules.
  for (const id of ["doctor", "listener"]) assert.match(SPECIALIST_PROFILES[id].note, /112/u, id);
  const page = publicSpecialistProfile("doctor");
  assert.match(page.note, /112/u);
  assert.ok(!("safety" in page) && !("urgent" in page) && !("expert" in page));
  assert.ok(!("note" in publicSpecialistProfile("lawyer")));
  assert.ok(!("safety" in publicSpecialistProfiles().chef));
  // Anything that is not one of the names is the writer, with a plain name.
  assert.equal(specialistProfile(["lawyer"]).id, "writer");
  assert.equal(specialistProfile({ toString: "lawyer" }).id, "writer");
  const book = readFileSync("public/book.js", "utf8");
  assert.match(book, /\$\("\.book-safety"\)\.hidden = !note;/u);
});

test("downloads name an untitled part by its specialist, and the person's copy of their data holds every project", async () => {
  const { chapterHeading } = await import("../src/services/bookExport.js");
  assert.equal(chapterHeading({ number: 1, title: "" }), "Глава 1");
  assert.equal(chapterHeading({ number: 1, title: "" }, "Част"), "Част 1");
  assert.equal(chapterHeading({ number: 2, title: "Увод" }, "Част"), "2. Увод");
  const service = createBookMemoryService({ store: memoryStore(), createId: ids() });
  const lawsuit = await service.createBook("ana", "Иванов срещу Петров", "lawyer");
  const book = await service.createBook("ana", "Сивата роба");
  await service.saveChapters("ana", lawsuit.id, [{ number: 1, title: "", text: "Искова молба." }]);
  await service.saveChapters("ana", book.id, [{ number: 1, title: "", text: "Мила влезе." }]);
  assert.match(String((await service.exportBook("ana", lawsuit.id, "html")).body), /<h2>Част 1<\/h2>/u);
  assert.match(String((await service.exportBook("ana", book.id, "html")).body), /<h2>Глава 1<\/h2>/u);
  // Word and EPUB name it the same way.
  const documentXml = async (id) => (await readZip((await service.exportBook("ana", id, "docx")).body)).find(({ name }) => name === "word/document.xml").text;
  assert.match(await documentXml(lawsuit.id), /<w:t xml:space="preserve">Част 1<\/w:t>/u);
  assert.match(await documentXml(book.id), /<w:t xml:space="preserve">Глава 1<\/w:t>/u);
  const epubText = async (id) => (await readZip((await service.exportBook("ana", id, "epub")).body)).map(({ text }) => text).join("\n");
  const lawEpub = await epubText(lawsuit.id);
  assert.match(lawEpub, /<h1>Част 1<\/h1>/u);
  assert.match(lawEpub, /<a href="chapter-1\.xhtml">Част 1<\/a>/u);
  assert.doesNotMatch(lawEpub, /Глава 1/u);
  assert.match(await epubText(book.id), /<h1>Глава 1<\/h1>/u);
  const projects = await service.exportAll("ana");
  assert.deepEqual(projects.map(({ specialist }) => specialist).sort(), ["lawyer", "writer"]);
  assert.equal(projects.find(({ specialist }) => specialist === "lawyer").parts[0].text, "Искова молба.");
  assert.match(readFileSync("src/services/accountDataService.js", "utf8"), /getBookMemoryService\(\)\.exportAll\(ownerId\)/u);
});

test("the page and the server split a file with the same code, in every language of the site", async () => {
  const { readHeading, splitManuscript: split } = await import("../public/manuscript-split.mjs");
  const book = readFileSync("public/book.js", "utf8");
  assert.match(book, /import\("\/manuscript-split\.mjs\?v=[^"]+"\)/u);
  assert.doesNotMatch(book, /PART_HEADING|const HEADING/u, "no second copy in the page");
  // The writer splits as before, at chapters only, word numbers too.
  for (const heading of ["Глава първа", "Chapter One", "Kapitel 1", "Capítulo 2", "Chapitre 3", "Capitolo 4", "Capitolul 5", "Глава 6. Кулата"]) {
    assert.ok(readHeading(heading), `writer: ${heading}`);
    assert.ok(readHeading(heading, { writer: false }), `others: ${heading}`);
  }
  assert.equal(readHeading("Част 2 Пътят"), null, "the writer does not split at parts");
  // The examples in the upload note of every language are headings.
  const english = new Map(
    readFileSync("public/locale-en.js", "utf8")
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|")),
  );
  const note = english.get("Файл .docx или .txt. Разделям го на части по заглавията „Част 1“, „Раздел 2“, „Урок 3“… Нищо не се пази, докато не натиснеш „Запази частите“.");
  const notes = [note, ...["de", "es", "fr", "it", "ro"].map((code) => JSON.parse(readFileSync(`public/locales/${code}.json`, "utf8"))[note])];
  for (const words of notes) {
    const examples = [...words.matchAll(/[„“«"]\s?(\p{L}+ \d+)\s?[“”»"]/gu)].map((match) => match[1]);
    assert.equal(examples.length, 3, words);
    for (const example of examples) assert.ok(readHeading(example, { writer: false }), example);
  }
  // Documents, the Romanian chapter word, quoted and question titles, and a
  // chapter word with a number written as a word are headings too.
  for (const heading of ["Document 3", "Dokument 3", "Documento 3: Contrato", "Documentul 4", "Capitol 2", "Capitol 2: Chiria", "Part 2 “The Tower”", "Sección 3 ¿Qué es un contrato?", "Глава първа. Пристигането.", "ГЛАВА ВТОРА", "Урок първи: Дроби", "Part One"]) {
    assert.ok(readHeading(heading, { writer: false }), `others: ${heading}`);
  }
  // Sentences stay text: „глава“ is also a head (of garlic, or the one that
  // hurts), a chapter word needs a number for everyone but the writer, and
  // a title of three words or more that ends like a sentence is a sentence.
  for (const line of [
    "Глава – силна болка, 3 дни",
    "Глава ме боли",
    "Глава ме боли от сутринта",
    "Глава кромид лук",
    "Глава чесън",
    "Глава: болка от сутринта",
    "Глава надолу при лицевите опори",
    "Kapitel 3 behandelt die Kosten.",
    "Capítulo 3 explica los costes.",
    "Chapitre 2 traite des coûts.",
    "Capitolo 4 spiega i costi.",
    "Capitolul 2 tratează costurile.",
    "Abschnitt 3 Satz 1 ist hier nicht anwendbar.",
    "Teil 2 Kapitel 4 fehlt noch.",
    "Lektion 5 Vokabeln bitte bis Montag lernen.",
    "Lezione 3 Marco non c'era.",
    "Документ 3 Иван Петров подписа на 5 март.",
    "Част 2 от наема се плаща авансово.",
    "Урок 3 е за дробите.",
    "Lesson I learned: never sign blind.",
    "Part I like most is the ending.",
    "Section did not apply here.",
    "Parte di questo contratto è nulla.",
    "Parte il treno alle 8.",
    "Section 1.1 Definitions",
    "Глава ме боли от сутринта.",
    "Chapter and verse were quoted.",
  ]) {
    assert.equal(readHeading(line, { writer: false }), null, line);
  }
  // A health diary, a recipe and a contract stay whole where their lines
  // only look like headings.
  assert.equal(split("Понеделник\nПих 1 таблетка аналгин.\nГлава – силна болка, 3 дни\nКръвно 140/90.\nВторник\nГлава ме боли\nПих ибупрофен 400 мг.", { writer: false }).length, 1);
  assert.equal(split("Продукти:\nГлава кромид лук\n2 моркова\nГлава чесън\n500 г кайма", { writer: false }).length, 1);
  assert.deepEqual(
    split("Teil 1: Vertrag\nDer Mieter zahlt 900 Euro.\nAbschnitt 3 Satz 1 ist hier nicht anwendbar.\nDie Kaution beträgt 2700 Euro.", { writer: false }).map((part) => part.title),
    ["Vertrag"],
  );
  // The writer still splits at every chapter line, as before.
  assert.equal(split("Глава ме боли от сутринта.\nТекст.").length, 1);
  assert.equal(readHeading("Глава ме боли от сутринта.").title, "Глава ме боли от сутринта.");
  // Three chapters of 30 000 characters: three parts for the editor too, so
  // nothing is cut at 50 000.
  const long = "дума ".repeat(6000);
  const manuscript = `Глава първа\n${long}\nГлава втора\n${long}\nГлава трета\n${long}`;
  assert.equal(split(manuscript, { writer: false }).length, 3);
  assert.equal(split(manuscript).length, 3);
  // The server uses the same splitter.
  const { splitManuscript } = await import("../src/services/bookMemoryService.js");
  assert.deepEqual(splitManuscript(manuscript, "editor"), split(manuscript, { writer: false }));
  assert.deepEqual(splitManuscript("Глава 1\nЕдно.\nЧаст 2\nДве."), split("Глава 1\nЕдно.\nЧаст 2\nДве."));
});

test("a late answer stays out of the panel, a delete starts over, and errors speak of the project", async () => {
  const book = readFileSync("public/book.js", "utf8");
  // Every AI answer is dropped when another specialist or project is open.
  for (const route of ["/suggest", "/check", "/draft"]) {
    const at = book.indexOf(`bookPath("${route}")`);
    assert.ok(at > 0, route);
    assert.match(book.slice(at, at + 200), /if \(!?fresh\(true\)\)/u, route);
  }
  assert.match(book, /generation \+= 1;/u);
  assert.match(book, /armTimer = setTimeout\(disarm, 4000\);/u);
  assert.match(book, /\/\/ A press of "Изтрий" from an earlier open does not carry over\.\n\s+disarm\(\);/u);
  assert.match(book, /if \(kinds\(\)\.some\(\(\[id\]\) => id === chosenKind\)\)/u);
  // The server's words for a book become the project's words, and each one
  // is a message the server really sends.
  const server = readFileSync("src/services/bookMemoryService.js", "utf8") + readFileSync("src/routes/bookMemoryRouter.js", "utf8");
  const errors = book.match(/const PROJECT_ERRORS = \{([\s\S]*?)\n {2}\};/u)[1];
  const pairs = [...errors.matchAll(/"([^"]+)": "([^"]+)"/gu)];
  assert.ok(pairs.length >= 15);
  for (const [, writerWords] of pairs) assert.ok(server.includes(`"${writerWords}"`), writerWords);
  assert.match(book, /throw new Error\(errorText\(data\.error\)\)/u);
});

test("every word of the panel has a translation, and no specialist word reuses another line's English", async () => {
  const { SPECIALIST_PROFILES } = await import("../src/services/specialistProfiles.js");
  const book = readFileSync("public/book.js", "utf8");
  const rows = readFileSync("public/locale-en.js", "utf8")
    .split("\n")
    .filter((line) => line.includes("|") && !line.startsWith("window."))
    .map((line) => line.split("|"));
  const english = new Map(rows);
  const catalogs = ["de", "es", "fr", "it", "ro"].map((code) => [code, JSON.parse(readFileSync(`public/locales/${code}.json`, "utf8"))]);
  const words = new Set();
  for (const match of book.matchAll(/\btext\(\s*"([^"]+)"\s*\)/gu)) words.add(match[1]);
  for (const match of book.matchAll(/pick\(\s*"([^"]+)",\s*"([^"]+)",?\s*\)/gu)) words.add(match[1]).add(match[2]);
  for (const match of book.match(/const PROJECT_ERRORS = \{([\s\S]*?)\n {2}\};/u)[1].matchAll(/"([^"]+)": "([^"]+)"/gu)) words.add(match[1]).add(match[2]);
  // Every message the server sends to the panel too. A download opens on a
  // page of its own, so its errors never reach the panel.
  const download = ["Избери DOCX, EPUB или PDF.", "Книгата още няма глави.", "Проектът още няма части.", "Книгата не можа да се изтегли."];
  const server = new Set();
  const service = readFileSync("src/services/bookMemoryService.js", "utf8");
  for (const match of service.matchAll(/BookMemoryError\(\s*(?:\w+\s*\?\s*)?"([^"]+)"(?:\s*:\s*"([^"]+)")?/gu)) server.add(match[1]).add(match[2] ?? match[1]);
  for (const match of readFileSync("src/routes/bookMemoryRouter.js", "utf8").matchAll(/(?:handle\(|fail\(res, error, )"([^"]+)"/gu)) server.add(match[1]);
  // The one message put together from two parts, as the person reads it.
  assert.match(service, /const empty = isWriter\(specialistProfile\(book\.domain\)\) \? "Паметта на книгата е празна\." : "Паметта на проекта е празна\.";\n\s+throw new BookMemoryError\(`\$\{empty\} Първо добави факти\.`/u);
  server.add("Паметта на книгата е празна. Първо добави факти.").add("Паметта на проекта е празна. Първо добави факти.");
  assert.equal([...service.matchAll(/BookMemoryError\(/gu)].length - 1, [...service.matchAll(/BookMemoryError\(\s*(?:\w+\s*\?\s*)?"/gu)].length, "every other message of the service is read");
  for (const line of download) assert.ok(server.delete(line), line);
  assert.ok(server.size >= 30, `${server.size} messages`);
  for (const line of server) words.add(line);
  const specialistWords = new Set();
  for (const profile of Object.values(SPECIALIST_PROFILES)) {
    for (const line of [profile.memory, ...Object.values(profile.kinds), profile.note].filter(Boolean)) {
      words.add(line);
      specialistWords.add(line);
    }
  }
  for (const line of words) {
    assert.ok(english.has(line), `English: ${line}`);
    for (const [code, catalog] of catalogs) assert.ok(catalog[english.get(line)], `${code}: ${line}`);
  }
  // „Сметка“ is a ledger account, not the person's account („Профил“), and
  // both keep their own words.
  assert.notEqual(english.get("Сметка"), english.get("Профил"));
  for (const [code, catalog] of catalogs) {
    assert.equal(typeof catalog[english.get("Профил")], "string", `${code}: Профил`);
    assert.equal(typeof catalog[english.get("Сметка")], "string", `${code}: Сметка`);
  }
  for (const line of specialistWords) {
    const others = rows.filter(([bg, en]) => en === english.get(line) && bg !== line).map(([bg]) => bg);
    assert.deepEqual(others, [], `${line} shares "${english.get(line)}"`);
  }
  // A part is not a page in French and Romanian.
  const fr = Object.fromEntries(catalogs)["fr"];
  const ro = Object.fromEntries(catalogs)["ro"];
  assert.equal(fr["from pt."], "à partir de la partie");
  assert.equal(ro["from pt."], "din partea");
});

test("the real router saves a new project under the specialist the page sends", async () => {
  const { createBookMemoryRouter } = await import("../src/routes/bookMemoryRouter.js");
  const calls = [];
  const router = createBookMemoryRouter({
    service: {
      createBook: async (...args) => {
        calls.push(args);
        return { id: "b1", title: args[1], domain: args[2] };
      },
    },
  });
  const layer = router.stack.find((item) => item.route?.path === "/" && item.route.methods.post);
  let status;
  let body;
  await layer.route.stack.at(-1).handle(
    { owner: { memoryOwnerId: "maria" }, body: { title: "Иванов срещу Петров", domain: "lawyer" } },
    {
      status(value) {
        status = value;
        return this;
      },
      json(value) {
        body = value;
      },
    },
  );
  assert.deepEqual(calls, [["maria", "Иванов срещу Петров", "lawyer"]]);
  assert.equal(status, 201);
  assert.equal(body.book.domain, "lawyer");
});

test("the real router hands the page each specialist's note, and never its rules", async () => {
  const { default: express } = await import("express");
  const { default: request } = await import("supertest");
  const { createBookMemoryRouter } = await import("../src/routes/bookMemoryRouter.js");
  const service = createBookMemoryService({ store: memoryStore(), createId: ids() });
  await service.createBook("maria", "Дневник", "doctor");
  await service.createBook("maria", "Сивата роба");
  const app = express();
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "maria" };
    next();
  });
  app.use("/api/books", createBookMemoryRouter({ service }));
  const doctor = (await request(app).get("/api/books?domain=doctor").expect(200)).body;
  assert.deepEqual(doctor.books.map(({ title }) => title), ["Дневник"]);
  assert.equal(doctor.profile.id, "doctor");
  assert.match(doctor.profile.note, /112/u);
  for (const key of ["safety", "urgent", "expert", "first"]) assert.ok(!(key in doctor.profile), key);
  const listener = (await request(app).get("/api/books?domain=listener").expect(200)).body;
  assert.match(listener.profile.note, /112/u);
  const lawyer = (await request(app).get("/api/books?domain=lawyer").expect(200)).body;
  assert.ok(!("note" in lawyer.profile));
  assert.deepEqual(lawyer.books, []);
});
