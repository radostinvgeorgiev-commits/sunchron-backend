import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  CONTACT_COLLECTION,
  CONTACT_RETENTION_MS,
  createContactAdminRouter,
  createContactRouter,
} from "../src/routes/contactRouter.js";

process.env.NODE_ENV = "test";
const { default: app } = await import("../server.js");

const nowMs = Date.parse("2026-11-28T10:00:00Z");

function memoryStore({ failSet = false, old = [] } = {}) {
  const saved = new Map();
  const deleted = [];
  const queries = [];
  return {
    saved,
    deleted,
    queries,
    async set(collection, id, data, options) {
      assert.equal(collection, CONTACT_COLLECTION);
      assert.deepEqual(options, { createOnly: true });
      if (failSet) throw new Error("storage down");
      saved.set(id, data);
    },
    async query(collection, options) {
      assert.equal(collection, CONTACT_COLLECTION);
      queries.push(options);
      return options.filters[0].op === "LESS_THAN" ? old.map((id) => ({ id, data: {} })) : [];
    },
    async delete(collection, id) {
      assert.equal(collection, CONTACT_COLLECTION);
      deleted.push(id);
    },
  };
}

function contactApp(store, options = {}) {
  let next = 0;
  return express().use(
    "/api/contact",
    createContactRouter({
      getStore: () => store,
      now: () => nowMs,
      newTicket: () => `0000000${++next}`.slice(-8),
      ...options,
    }),
  );
}

test("a message is saved with a number and the person sees it", async () => {
  const store = memoryStore();
  await request(contactApp(store))
    .post("/api/contact?lang=de")
    .type("form")
    .send({
      name: "  Мария   Иванова ",
      email: " Maria@Example.com ",
      topic: "data",
      message: "  Искам копие на данните си.\r\nБлагодаря!  ",
      website: "",
    })
    .expect(303)
    .expect("Location", "/help?contact=received&ticket=00000001&lang=de#contact");
  assert.deepEqual(store.saved.get("00000001"), {
    name: "Мария Иванова",
    email: "maria@example.com",
    topic: "data",
    message: "Искам копие на данните си.\nБлагодаря!",
    ticket: "00000001",
    lang: "de",
    submittedAt: "2026-11-28T10:00:00.000Z",
    status: "new",
    noticeVersion: "contact-v1",
  });
});

test("wrong input, a filled hidden field or a storage error save nothing", async () => {
  const store = memoryStore();
  const testApp = contactApp(store);
  for (const body of [
    { email: "not-an-email", message: "Достатъчно дълго съобщение." },
    { email: "person@example.com", message: "Кратко" },
    { email: "person@example.com", message: "x".repeat(4001) },
    { email: "person@example.com", name: "x".repeat(101), message: "Достатъчно дълго съобщение." },
  ]) {
    await request(testApp)
      .post("/api/contact")
      .type("form")
      .send(body)
      .expect(303)
      .expect("Location", "/help?contact=invalid#contact");
  }
  const bot = await request(testApp)
    .post("/api/contact")
    .type("form")
    .send({ email: "bot@example.com", message: "Купи евтино сега!!!", website: "https://spam.example" })
    .expect(303);
  assert.match(bot.headers.location, /contact=received/u);
  assert.equal(store.saved.size, 0);

  await request(contactApp(memoryStore({ failSet: true })))
    .post("/api/contact")
    .type("form")
    .send({ email: "person@example.com", message: "Достатъчно дълго съобщение." })
    .expect(303)
    .expect("Location", "/help?contact=unavailable#contact");
});

test("an unknown topic becomes “other” and too many messages are stopped", async () => {
  const store = memoryStore();
  const testApp = contactApp(store, { limit: 2 });
  const send = () =>
    request(testApp)
      .post("/api/contact")
      .type("form")
      .send({ email: "person@example.com", topic: "<script>", message: "Достатъчно дълго съобщение." });
  await send().expect(303);
  await send().expect(303);
  await send().expect(303).expect("Location", "/help?contact=limited#contact");
  assert.equal(store.saved.size, 2);
  assert.equal(store.saved.get("00000001").topic, "other");
});

test("messages older than one year are removed", async () => {
  const store = memoryStore({ old: ["old-1", "old-2"] });
  await request(contactApp(store))
    .post("/api/contact")
    .type("form")
    .send({ email: "person@example.com", message: "Достатъчно дълго съобщение." })
    .expect(303);
  const cleanup = store.queries.find((query) => query.filters[0].op === "LESS_THAN");
  assert.equal(cleanup.filters[0].field, "submittedAt");
  assert.equal(cleanup.filters[0].value, new Date(nowMs - CONTACT_RETENTION_MS).toISOString());
  assert.deepEqual(store.deleted, ["old-1", "old-2"]);
});

test("the owner's list escapes the text and is private on the real server", async () => {
  const store = memoryStore();
  store.query = async (_collection, options) =>
    options.filters[0].op === "LESS_THAN"
      ? []
      : [
          {
            id: "ABCDEF12",
            data: {
              ticket: "ABCDEF12",
              name: "<b>Иван</b>",
              email: "ivan@example.com",
              topic: "problem",
              message: "<script>alert(1)</script>\nВтори ред",
              submittedAt: "2026-11-28T09:30:00.000Z",
            },
          },
        ];
  const testApp = express().use(
    "/admin/contact",
    createContactAdminRouter({ getStore: () => store, now: () => nowMs }),
  );
  const list = await request(testApp).get("/admin/contact").expect(200);
  assert.match(list.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(list.text, /<script>|<b>Иван/u);
  assert.match(list.text, /Проблем/u);
  assert.match(list.text, /2026-11-28 09:30/u);
  assert.match(list.text, /mailto:ivan@example\.com\?subject=NovariumAI%20%C2%B7%20ABCDEF12/u);
  assert.equal(list.headers["cache-control"], "private, no-store");

  await request(app).get("/admin/contact").expect(401);
  const help = await request(app).get("/help").expect(200);
  assert.match(help.text, /<form id="contact-form" method="post" action="\/api\/contact">/u);
  assert.match(help.text, /<script src="\/contact\.js" defer><\/script>/u);
});

test("the contact form and its messages are translated", async () => {
  const readPublic = (file) => readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
  const english = new Map(
    (await readPublic("locale-en.js"))
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|")),
  );
  const catalogs = await Promise.all(
    ["de", "es", "fr", "it", "ro"].map(async (language) =>
      JSON.parse(await readPublic(`locales/${language}.json`)),
    ),
  );
  const help = await readPublic("help.html");
  const section = help.match(/<section class="request-panel contact-panel" id="contact">[\s\S]*?<\/section>/u)[0];
  const support = help.match(/<section class="product-section" id="support">[\s\S]*?<\/section>/u)[0];
  const texts = `${section}${support}`
    .split(/<[^>]+>/u)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter((part) => /[А-Яа-я]/u.test(part));
  const script = await readPublic("contact.js");
  for (const [, value] of script.matchAll(/text\(\s*"([^"]+)"/gu)) texts.push(value);
  assert.ok(texts.length > 20);
  for (const text of texts) {
    const en = english.get(text);
    assert.ok(en, `missing English for “${text}”`);
    for (const catalog of catalogs) assert.ok(catalog[en], `missing translation for “${en}”`);
  }
});
