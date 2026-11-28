import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import express from "express";
import { JSDOM } from "jsdom";
import request from "supertest";

import { createBookMemoryService } from "../src/services/bookMemoryService.js";
import { createBookMemoryRouter } from "../src/routes/bookMemoryRouter.js";

// The real panel (public/book.js) in jsdom; its requests go to the real
// router and service. hold(match) keeps the matching requests on their way
// until release() lets them through, as a slow connection would. jsdom
// cannot import a module, so the panel's one import of the shared splitter
// loads the same file from disk.
const source = readFileSync(new URL("../public/book.js", import.meta.url), "utf8");
const SPLITTER_IMPORT = /\bimport\("(\/manuscript-split\.mjs)\?v=[^"]+"\)/gu;
assert.equal(source.match(SPLITTER_IMPORT)?.length, 1, "the panel imports the shared splitter once");
const panelSource = source.replace(SPLITTER_IMPORT, (_, path) => `globalThis.loadSplitter(${JSON.stringify(path)})`);

function memoryStore() {
  const rows = new Map();
  return {
    async get(collection, id) {
      const data = rows.get(`${collection}/${id}`);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async commitOperations(operations) {
      for (const { type, collection, id, data } of operations) {
        if (type === "delete") rows.delete(`${collection}/${id}`);
        else rows.set(`${collection}/${id}`, structuredClone(data));
      }
    },
  };
}

async function panel(t, { askAi = async () => '{"issues":[]}' } = {}) {
  let next = 0;
  const service = createBookMemoryService({ store: memoryStore(), createId: () => `id${(next += 1)}`, askAi, env: {} });
  const app = express();
  app.use(express.json());
  app.use((req, _res, done) => {
    req.owner = { memoryOwnerId: "maria" };
    done();
  });
  app.use("/api/books", createBookMemoryRouter({ service }));
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => window.close());
  const sent = [];
  const held = [];
  let holding = () => false;
  let inflight = 0;
  window.fetch = (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    sent.push(call);
    const answer = async () => {
      inflight += 1;
      try {
        let req = request(app)[call.method.toLowerCase()](call.url);
        if (call.body) req = req.set("Content-Type", "application/json").send(call.body);
        const res = await req;
        return { ok: res.status < 400, status: res.status, json: async () => res.body };
      } finally {
        inflight -= 1;
      }
    };
    if (holding(call)) return new Promise((resolve) => held.push(() => resolve(answer())));
    return answer();
  };
  window.NovariumLocale = { text: (value) => value };
  window.loadSplitter = (path) => import(new URL(`../public${path}`, import.meta.url));
  window.eval(panelSource);
  const { document } = window;
  const $ = (selector) => document.querySelector(`.book-dialog ${selector}`);
  const settle = async () => {
    do await new Promise((resolve) => setTimeout(resolve, 10));
    while (inflight > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const open = async (assistant) => {
    document.dispatchEvent(new window.CustomEvent("novarium:book", { detail: { assistant } }));
    await settle();
  };
  const choose = async (id) => {
    $(".book-select").value = id;
    $(".book-select").dispatchEvent(new window.Event("change"));
    await settle();
  };
  const submit = async (selector) => {
    $(selector).dispatchEvent(new window.Event("submit", { cancelable: true }));
    await settle();
  };
  const press = async (selector) => {
    $(selector).click();
    await settle();
  };
  const hold = (match) => (holding = match);
  const release = async () => {
    holding = () => false;
    while (held.length) held.shift()();
    await settle();
  };
  const deletes = () => sent.filter((call) => call.method === "DELETE");
  // A file the person picks: read and split in the page, nothing sent yet.
  const upload = async (name, content) => {
    const input = $(".book-upload-file");
    const file = new File([content], name, { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    input.dispatchEvent(new window.Event("change"));
    for (let tries = 0; tries < 300 && /^Чета/u.test($(".share-status").textContent); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
  };
  const options = () => [...document.querySelectorAll(".book-dialog .book-select option")].map((option) => option.textContent);
  return { service, window, document, $, open, choose, submit, press, hold, release, settle, sent, deletes, upload, options };
}

const two = async (service) => {
  const z = await service.createBook("maria", "Дело Z", "lawyer");
  await service.addFacts("maria", z.id, [{ kind: "place", name: "Срок Z", text: "Срокът по дело Z е 14 дни." }]);
  const x = await service.createBook("maria", "Дело X", "lawyer");
  await service.addFacts("maria", x.id, [{ kind: "place", name: "Плащане", text: "Ответникът плаща до 30 дни." }]);
  return { x, z };
};
const projectsOf = async (service) => (await service.list("maria")).map((book) => book.title);

test("a press made while a delete is on its way does not delete the project shown next", async (t) => {
  const page = await panel(t);
  const { x, z } = await two(page.service);
  await page.open("lawyer");
  assert.equal(page.$(".book-select").value, x.id);
  await page.press(".book-delete");
  assert.equal(page.$(".book-delete").textContent, "Натисни пак, за да изтриеш");
  page.hold((call) => call.method === "DELETE");
  await page.press(".book-delete");
  assert.equal(page.$(".book-delete").disabled, true, "the button waits for the answer");
  // The reviewer's third press, while „Изтриване…“ is on screen: nothing.
  await page.press(".book-delete");
  await page.release();
  assert.equal(page.$(".book-select").value, z.id);
  assert.equal(page.$(".book-delete").disabled, false);
  assert.equal(page.$(".book-delete").textContent, "Изтрий проекта", "Дело Z is not armed");
  await page.press(".book-delete");
  assert.equal(page.deletes().length, 1, "one press on Дело Z sends nothing");
  assert.deepEqual(await projectsOf(page.service), ["Дело Z"]);
});

test("a new project opens unarmed, and a project shown after a delete starts clean", async (t) => {
  const asked = [];
  const page = await panel(t, {
    askAi: async ({ input }) => {
      asked.push(input[0].content);
      return '{"facts":[{"kind":"rule","name":"Неустойка","text":"Неустойката по договора с Иванов е 5%.","quote":"неустойка 5%"}]}';
    },
  });
  const { x, z } = await two(page.service);
  await page.open("lawyer");
  // Armed, then a new project within the 4 seconds: it opens unarmed.
  await page.press(".book-delete");
  page.$(".book-new-title").value = "Ново дело";
  await page.submit(".book-new");
  assert.equal(page.$(".book-select").selectedOptions[0].textContent, "Ново дело");
  assert.equal(page.$(".book-delete").textContent, "Изтрий проекта");
  await page.press(".book-delete");
  assert.equal(page.deletes().length, 0, "one press on the new project sends nothing");

  // Suggestions for Дело X stay with Дело X: after X is deleted they are gone.
  await page.choose(x.id);
  page.$(".book-extract-text").value = "Договор с Иванов: неустойка 5% при забава.";
  await page.press(".book-extract-run");
  assert.equal(page.$(".book-suggestions").hidden, false);
  await page.press(".book-delete");
  await page.press(".book-delete");
  assert.notEqual(page.$(".book-select").value, x.id);
  assert.equal(page.$(".book-suggestions").hidden, true);
  const saves = page.sent.filter((call) => call.url.endsWith("/facts")).length;
  await page.press(".book-keep");
  assert.equal(page.sent.filter((call) => call.url.endsWith("/facts")).length, saves, "„Запази избраните“ writes nothing into another project");
  const zFacts = (await page.service.list("maria")).find((book) => book.id === z.id).facts.map((fact) => fact.text);
  assert.deepEqual(zFacts, ["Срокът по дело Z е 14 дни."]);
});

test("a late fact save keeps the fact typed for the next project", async (t) => {
  const page = await panel(t);
  const { x, z } = await two(page.service);
  await page.open("lawyer");
  page.$(".book-add-name").value = "Свидетел";
  page.$(".book-add-text").value = "Свидетел по X е Мария.";
  page.hold((call) => call.url.endsWith("/facts"));
  await page.submit(".book-add");
  await page.choose(z.id);
  page.$(".book-add-name").value = "Съд";
  page.$(".book-add-text").value = "Делото Z е в Софийски районен съд.";
  await page.release();
  assert.equal(page.$(".book-add-name").value, "Съд");
  assert.equal(page.$(".book-add-text").value, "Делото Z е в Софийски районен съд.");
  const xFacts = (await page.service.list("maria")).find((book) => book.id === x.id).facts.map((fact) => fact.text);
  assert.ok(xFacts.includes("Свидетел по X е Мария."), "the fact went to Дело X");
  // Without a change in between, the saved fact leaves the form as before.
  page.$(".book-add-name").value = "Вещо лице";
  page.$(".book-add-text").value = "Вещото лице е инж. Петров.";
  await page.submit(".book-add");
  assert.equal(page.$(".book-add-name").value, "");
  assert.equal(page.$(".book-add-text").value, "");
});

// The model in these tests: a check finds nothing, a suggestion is one rule,
// and a draft is one sentence.
const model = async ({ input }) => {
  const system = input[0].content;
  if (/"issues"/u.test(system)) return '{"issues":[]}';
  if (/"facts"/u.test(system)) return '{"facts":[{"kind":"rule","name":"Неустойка","text":"Неустойката по договора с Иванов е 5%.","quote":"неустойка 5%"}]}';
  return "Ищецът Иванов иска 900 лв.";
};

test("a draft and a saved part leave their hint on screen, and a choice in the list starts the next project clean", async (t) => {
  const page = await panel(t, { askAi: model });
  const { x, z } = await two(page.service);
  await page.open("lawyer");
  assert.equal(page.$(".book-select").value, x.id);
  await page.press('[data-tab="chapters"]');
  page.$(".book-draft-plan").value = "Искова молба за 900 лв.";
  await page.press(".book-draft-run");
  assert.equal(page.$(".book-chapter-text").value, "Ищецът Иванов иска 900 лв.");
  assert.equal(page.$(".book-draft-check").textContent, "Проверка на черновата: 100/100 · няма противоречия");
  assert.equal(page.$(".share-status").textContent, "Черновата е в полето отгоре. Прочети я и натисни „Запази частта“, ако я искаш.");
  await page.submit(".book-chapter-form");
  assert.equal(page.$(".share-status").textContent, "Частта е запазена: 1");
  assert.equal((await page.service.getChapter("maria", x.id, 1)).text, "Ищецът Иванов иска 900 лв.");

  // Suggestions, an armed delete and the draft check of Дело X are not Дело Z's.
  await page.press('[data-tab="facts"]');
  page.$(".book-extract-text").value = "Договор с Иванов: неустойка 5% при забава.";
  await page.press(".book-extract-run");
  assert.equal(page.$(".book-suggestions").hidden, false);
  await page.press(".book-delete");
  assert.equal(page.$(".book-delete").textContent, "Натисни пак, за да изтриеш");
  await page.choose(z.id);
  assert.equal(page.$(".book-suggestions").hidden, true);
  assert.equal(page.$(".book-draft-check").textContent, "");
  assert.equal(page.$(".book-delete").textContent, "Изтрий проекта");
  const before = page.sent.length;
  await page.press(".book-keep");
  await page.press(".book-delete");
  assert.equal(page.sent.length, before, "nothing is sent for Дело Z");
  const zFacts = (await page.service.list("maria")).find((book) => book.id === z.id).facts.map((fact) => fact.text);
  assert.deepEqual(zFacts, ["Срокът по дело Z е 14 дни."]);
});

test("an answer for the previous specialist stays out of the next one's panel", async (t) => {
  const page = await panel(t);
  await two(page.service);
  await page.service.createBook("maria", "Дневник", "doctor");
  await page.open("lawyer");
  // The kind chosen for the lawyer does not carry over to the doctor.
  page.$(".book-add-kind").value = "rule";
  // A new case is on its way while the person opens the doctor.
  page.hold((call) => call.method === "POST" && call.url === "/api/books");
  page.$(".book-new-title").value = "Ново дело";
  await page.submit(".book-new");
  await page.open("doctor");
  await page.release();
  assert.deepEqual(page.options(), ["Дневник"]);
  assert.equal(page.$(".book-add-kind").selectedIndex, 0);
  assert.ok((await projectsOf(page.service)).includes("Ново дело"), "the case was made for the lawyer");

  // The parts of a file are on their way while the person opens the doctor.
  await page.open("lawyer");
  const caseId = page.$(".book-select").value;
  await page.press('[data-tab="chapters"]');
  await page.upload("delo.txt", "Част 1 Увод\nИщецът е Иванов.\nЧаст 2 Доказателства\nОтветникът е Петров.");
  assert.equal(page.$(".book-upload-count").textContent, "Намерих части: 2 · 1. Увод, 2. Доказателства");
  page.hold((call) => call.url.endsWith("/chapters"));
  await page.press(".book-upload-save");
  await page.open("doctor");
  await page.release();
  assert.deepEqual(page.options(), ["Дневник"]);
  assert.equal(page.$(".share-status").textContent, "", "the doctor's panel says nothing of the case's parts");
  assert.equal((await page.service.list("maria")).find((book) => book.id === caseId).chapters.length, 2, "the parts went to the case");
});

test("a file is split by the page's shared splitter, and its parts stay with their project", async (t) => {
  const page = await panel(t);
  const { x, z } = await two(page.service);
  await page.open("lawyer");
  assert.equal(page.$(".book-select").value, x.id);
  await page.press('[data-tab="chapters"]');
  // A sentence that starts with „Част 2“ stays in the part before it.
  const file = "Част 1 Увод\nИщецът е Иванов.\nРаздел 2\nОтветникът е Петров.\nЧаст 2 от наема се плаща авансово.\nНаемът е 900 лв.";
  await page.upload("delo.txt", file);
  assert.equal(page.$(".book-upload-count").textContent, "Намерих части: 2 · 1. Увод, 2. Част");
  assert.equal(page.$(".book-upload-preview").hidden, false);
  // Read for Дело X, then Дело X is deleted: Дело Z gets none of its parts.
  await page.press(".book-delete");
  await page.press(".book-delete");
  assert.equal(page.$(".book-select").value, z.id);
  assert.equal(page.$(".book-upload-preview").hidden, true);
  await page.press(".book-upload-save");
  assert.equal(page.sent.filter((call) => call.url.endsWith("/chapters")).length, 0, "nothing is saved into Дело Z");
  // Read again for Дело Z and saved: the sentence is in the second part.
  await page.upload("delo.txt", file);
  await page.press(".book-upload-save");
  assert.equal(page.$(".share-status").textContent, "Запазени части: 2. Сега можеш да извадиш факти от тях в „Факти“.");
  assert.equal(page.$(".book-upload-preview").hidden, true);
  assert.equal((await page.service.getChapter("maria", z.id, 1)).text, "Ищецът е Иванов.");
  assert.equal((await page.service.getChapter("maria", z.id, 2)).text, "Ответникът е Петров.\nЧаст 2 от наема се плаща авансово.\nНаемът е 900 лв.");
});
