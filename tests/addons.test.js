import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createAddonRouter } from "../src/routes/addonRouter.js";
import {
  checkDataUrl,
  createAddonService,
  fillDataUrl,
  isPublicAddress,
  runInSandbox,
} from "../src/services/addonService.js";

function memoryStore() {
  const rows = new Map();
  return {
    rows,
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

const GREETING = "function run(input) { return `Здравей, ${input}!`; }";

test("the sandbox runs the person's code and returns its answer and logs", async () => {
  const result = await runInSandbox("function run(input, data) { log('got', data.n); return { twice: data.n * 2, input }; }", {
    input: "x",
    data: { n: 21 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), { twice: 42, input: "x" });
  assert.deepEqual(result.logs, ["got 21"]);
});

test("the sandbox has no way out: no process, require, fetch, or host objects", async () => {
  const probe = await runInSandbox(
    "function run() { return [typeof process, typeof require, typeof fetch, typeof globalThis.__aicoreArgs, typeof setTimeout, typeof XMLHttpRequest].join(','); }",
  );
  assert.equal(probe.output, "undefined,undefined,undefined,undefined,undefined,undefined");
  const escape = await runInSandbox("function run() { return this.constructor.constructor('return typeof process')(); }");
  assert.equal(escape.ok, true);
  assert.equal(escape.output, "undefined");
});

test("endless loops and memory hogs are stopped", async () => {
  const loop = await runInSandbox("function run() { while (true) {} }", { timeMs: 100 });
  assert.equal(loop.ok, false);
  assert.match(loop.error, /твърде дълго/u);
  const hog = await runInSandbox("function run() { const a = []; while (true) a.push('x'.repeat(100000)); }", { timeMs: 3000 });
  assert.equal(hog.ok, false);
  assert.match(hog.error, /памет|твърде дълго/u);
  const missing = await runInSandbox("const run = 5;");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /run/u);
});

test("data addresses: only public https names, and the input cannot change the site", () => {
  assert.equal(checkDataUrl(""), "");
  assert.equal(checkDataUrl("https://api.example.com/q?city={input}"), "https://api.example.com/q?city={input}");
  for (const bad of [
    "http://api.example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://user:pass@api.example.com/",
    "https://api.example.com:8443/",
    "https://{input}/",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => checkDataUrl(bad), undefined, bad);
  }
  assert.equal(fillDataUrl("https://a.example.com/?q={input}", "a&b=/"), "https://a.example.com/?q=a%26b%3D%2F");
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("own add-ons are private, reviewed copies go to the store, edits need a new review", async () => {
  let next = 0;
  const store = memoryStore();
  const service = createAddonService({ store, createId: () => `a${(next += 1)}`, fetchData: async () => ({ temp: 5 }) });
  const { item } = await service.save("maria", { name: "Поздрав", description: "Казва здрасти", code: GREETING });
  assert.equal(item.status, "draft");
  assert.deepEqual(await service.listMine("ivan"), []);
  assert.deepEqual(await service.listPublic(), []);
  await assert.rejects(service.runPublic("a1", "Иван"), /не е намерена/u);
  await assert.rejects(service.runMine("ivan", "a1", "x"), /не е намерена/u);
  assert.equal((await service.runMine("maria", "a1", "Мария")).output, "Здравей, Мария!");

  await service.submit("maria", "a1");
  assert.equal((await service.listMine("maria"))[0].status, "pending");
  const pending = await service.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].authorKey, undefined);
  assert.equal((await service.runPending("a1", "Радко")).output, "Здравей, Радко!");
  await service.approve("a1", "Браво");
  const [published] = await service.listPublic();
  assert.equal(published.name, "Поздрав");
  assert.equal(published.authorKey, undefined);
  assert.equal((await service.runPublic("a1", "Иван")).output, "Здравей, Иван!");
  assert.equal((await service.listMine("maria"))[0].status, "public");

  // A change is a new draft; the store keeps the reviewed code.
  await service.save("maria", { id: "a1", name: "Поздрав", code: "function run(){ return 'нов'; }" });
  assert.equal((await service.listMine("maria"))[0].status, "draft");
  assert.equal((await service.runPublic("a1", "Иван")).output, "Здравей, Иван!");
  await service.submit("maria", "a1");
  await service.reject("a1", "Не");
  const [rejected] = await service.listMine("maria");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewNote, "Не");
  assert.equal((await service.runPublic("a1", "Иван")).output, "Здравей, Иван!");

  await service.unpublish("maria", "a1");
  assert.deepEqual(await service.listPublic(), []);
});

test("data comes from the declared address with the input filled in", async () => {
  const asked = [];
  const service = createAddonService({
    store: memoryStore(),
    fetchData: async (url) => (asked.push(url), { temp: 7 }),
  });
  const result = await service.test("maria", {
    code: "function run(input, data) { return `${input}: ${data.temp}`; }",
    dataUrl: "https://api.example.com/w?city={input}",
    input: "Sofia",
  });
  assert.equal(result.output, "Sofia: 7");
  assert.deepEqual(asked, ["https://api.example.com/w?city=Sofia"]);
});

test("deleting an account removes the person's add-ons and their store copies", async () => {
  let next = 0;
  const store = memoryStore();
  const service = createAddonService({ store, createId: () => `a${(next += 1)}` });
  await service.save("maria", { name: "A", code: GREETING });
  await service.save("ivan", { name: "B", code: GREETING });
  await service.submit("maria", "a1");
  await service.approve("a1");
  await service.submit("ivan", "a2");
  await service.clear("maria");
  assert.deepEqual(await service.listMine("maria"), []);
  assert.deepEqual(await service.listPublic(), []);
  assert.deepEqual((await service.listPending()).map((item) => item.id), ["a2"]);
});

test("limits: name and run() are required, 20 per person", async () => {
  let next = 0;
  const service = createAddonService({ store: memoryStore(), createId: () => `a${(next += 1)}` });
  await assert.rejects(service.save("m", { code: GREETING }), /име/u);
  await assert.rejects(service.save("m", { name: "x", code: "return 1" }), /run/u);
  for (let index = 0; index < 20; index += 1) await service.save("m", { name: `n${index}`, code: GREETING });
  await assert.rejects(service.save("m", { name: "extra", code: GREETING }), /20/u);
});

test("only the owner sees and decides the review queue", async () => {
  let next = 0;
  const service = createAddonService({ store: memoryStore(), createId: () => `a${(next += 1)}` });
  const app = (role) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, nextHandler) => {
      req.owner = { role, memoryOwnerId: role === "owner" ? "owner-1" : "member-1" };
      nextHandler();
    });
    server.use("/api/addons", createAddonRouter({ service }));
    return server;
  };
  const member = app("member");
  const owner = app("owner");
  const saved = await request(member).post("/api/addons/mine").send({ name: "Поздрав", code: GREETING }).expect(200);
  await request(member).post(`/api/addons/mine/${saved.body.item.id}/submit`).expect(200);
  await request(member).get("/api/addons/review").expect(403);
  await request(member).post("/api/addons/review/a1/approve").expect(403);
  const queue = await request(owner).get("/api/addons/review").expect(200);
  assert.equal(queue.body.items.length, 1);
  await request(owner).post("/api/addons/review/a1/approve").expect(200);
  const run = await request(owner).post("/api/addons/store/a1/run").send({ input: "свят" }).expect(200);
  assert.equal(run.body.output, "Здравей, свят!");
  await request(owner).get("/api/addons/mine").expect(200, { items: [] });
  const bad = await request(member).post("/api/addons/test").send({ name: "x", code: "nope" }).expect(400);
  assert.match(bad.body.error, /run/u);
});

test("the page offers „Добавки“ to every account and the server mounts it behind a session", () => {
  const html = readFileSync("public/index.html", "utf8");
  const ui = readFileSync("public/ui-refresh.js", "utf8");
  const server = readFileSync("server.js", "utf8");
  assert.match(html, /addons\.js/u);
  assert.match(ui, /data-plus="addons"/u);
  assert.match(server, /"\/api\/addons",\s*requireOwnerSession,\s*privateApiRateLimiter/u);
});
