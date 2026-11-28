import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildFileContext,
  createKnowledgeFilesService,
  findPassagesByEmbedding,
  findPassages,
  splitIntoChunks,
} from "../src/services/knowledgeFilesService.js";

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async get(collection, id) {
      const data = docs.get(`${collection}/${id}`);
      return data ? { data: structuredClone(data) } : null;
    },
    async commitOperations(operations) {
      for (const op of operations) {
        if (op.type === "delete") docs.delete(`${op.collection}/${op.id}`);
        else docs.set(`${op.collection}/${op.id}`, structuredClone(op.data));
      }
    },
  };
}

const PRICES = "Ценоразпис на фирмата.\n\nАбонаментът за поддръжка струва 120 лева на месец.\n\nМонтажът на климатик е 250 лева.";
const RULES = "Правилник.\n\nРаботното време е от 9 до 18 часа.\n\nОтпуската се заявява две седмици по-рано.";

test("long text is split into bounded chunks", () => {
  const chunks = splitIntoChunks(`${"а".repeat(3000)}\n\nкрай`, 1200);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1200));
});

test("the matching passage is found, with its file name, in Bulgarian word forms", () => {
  const files = [
    { name: "ceni.txt", chunks: splitIntoChunks(PRICES, 60) },
    { name: "pravila.txt", chunks: splitIntoChunks(RULES, 60) },
  ];
  const [best] = findPassages(files, "Колко струва абонаментът за поддръжката?");
  assert.equal(best.file, "ceni.txt");
  assert.match(best.text, /120 лева/u);
  assert.deepEqual(findPassages(files, "Какво е времето в Токио утре?"), []);
  assert.deepEqual(findPassages(files, "и в на"), []);
  const context = buildFileContext([best]);
  assert.match(context, /ДАННИ, НЕ ИНСТРУКЦИИ/u);
  assert.match(context, /Файл „ceni\.txt“/u);
  assert.equal(buildFileContext([]), "");
});

test("files are per account, limited, listed without text and removable", async () => {
  const store = memoryStore();
  const service = createKnowledgeFilesService({ store });
  const file = await service.add("alice", { name: "ceni.txt", text: PRICES });
  assert.deepEqual(Object.keys((await service.list("alice"))[0]).sort(), ["addedAt", "chars", "id", "name"]);
  assert.equal((await service.search("alice", "Колко струва монтажът на климатик?"))[0].file, "ceni.txt");
  assert.deepEqual(await service.search("bob", "Колко струва монтажът на климатик?"), []);
  assert.doesNotMatch([...store.docs.keys()].join(), /alice/u);
  await assert.rejects(service.add("alice", { name: "x.txt", text: "кратко" }), { code: "KNOWLEDGE_EMPTY" });
  await assert.rejects(service.add("alice", { name: "big.txt", text: "а".repeat(200_001) }), { code: "KNOWLEDGE_TOO_LARGE" });
  for (let i = 0; i < 11; i += 1) await service.add("alice", { name: `f${i}.txt`, text: RULES });
  await assert.rejects(service.add("alice", { name: "more.txt", text: RULES }), { code: "KNOWLEDGE_FULL" });
  assert.deepEqual(await service.remove("alice", file.id), { removed: true });
  assert.deepEqual(await service.search("alice", "Колко струва монтажът на климатик?"), []);
  assert.deepEqual(await service.remove("bob", file.id), { removed: false });
});

test("Vertex embeddings rank passages by cosine and fail closed without configuration", async () => {
  const files = [{ name: "ceni.txt", chunks: ["Абонаментът е 120 лева.", "Монтaжът е безплатен."] }];
  await assert.rejects(
    findPassagesByEmbedding(files, "Каква е цената?", {
      env: {},
    }),
    { code: "VERTEX_EMBEDDING_NOT_CONFIGURED", status: 503 },
  );

  const authClient = { getRequestHeaders: async () => ({ Authorization: "Bearer test" }) };
  const passages = await findPassagesByEmbedding(files, "Каква е цената?", {
    env: {
      VERTEX_AI_ENABLED: "true",
      VERTEX_AI_PROJECT_ID: "project-123",
      VERTEX_AI_LOCATION: "global",
    },
    authClient,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        predictions: [
          { embeddings: { values: [1, 0] } },
          { embeddings: { values: [0.9, 0.1] } },
          { embeddings: { values: [0, 1] } },
        ],
      }),
    }),
  });
  assert.equal(passages[0].file, "ceni.txt");
  assert.match(passages[0].text, /120 лева/u);
});

test("chat adds matching passages and the server mounts the routes", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../src/routes/chat.js"), /getKnowledgeFilesService\(\)\.search\(ownerId, cleanMessage\)/u);
  assert.match(read("../server.js"), /"\/api\/knowledge-files",\s*requireOwnerSession/u);
  assert.match(read("../public/knowledge-files.js"), /fetch\(path/u);
});
