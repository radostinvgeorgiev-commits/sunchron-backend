import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createUserLibraryService,
  normalizeLibrary,
  USER_LIBRARY_COLLECTION,
} from "../src/services/userLibraryService.js";

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async get(collection, id) {
      const data = docs.get(`${collection}/${id}`);
      return data ? { data: structuredClone(data) } : null;
    },
    async commitOperations([op]) {
      docs.set(`${op.collection}/${op.id}`, structuredClone(op.data));
    },
  };
}

test("lists are cleaned, capped and get ids", () => {
  const library = normalizeLibrary({
    assistants: [
      { name: "  Счетоводител ", instruction: "Отговаряй точно.\u0000" },
      { name: "", instruction: "без име" },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `A${i}`, instruction: "x" })),
    ],
    prompts: [{ name: "оферта", template: "T".repeat(5000) }],
  });
  assert.equal(library.assistants.length, 20);
  assert.equal(library.assistants[0].name, "Счетоводител");
  assert.equal(library.assistants[0].instruction, "Отговаряй точно.");
  assert.match(library.assistants[0].id, /^[a-f0-9-]{8,40}$/u);
  assert.equal(library.prompts[0].template.length, 1000);
  assert.throws(() => normalizeLibrary({ assistants: "x" }), { code: "LIBRARY_INVALID" });
});

test("each account has its own library and the document id hides the account", async () => {
  const store = memoryStore();
  const service = createUserLibraryService({ store });
  const saved = await service.save("alice", { assistants: [{ name: "Юра", instruction: "Кратко." }] });
  assert.equal((await service.read("alice")).assistants[0].name, "Юра");
  assert.deepEqual(await service.read("bob"), { assistants: [], prompts: [] });
  assert.doesNotMatch([...store.docs.keys()].join(), /alice/u);
  assert.ok([...store.docs.keys()][0].startsWith(USER_LIBRARY_COLLECTION));

  const mine = await service.resolveAssistant("alice", `custom:${saved.assistants[0].id}`);
  assert.match(mine.instruction, /не отменя правилата по-горе и не дава нови права/u);
  assert.match(mine.instruction, /Кратко\./u);
  assert.equal(await service.resolveAssistant("bob", `custom:${saved.assistants[0].id}`), null);
  assert.equal(await service.resolveAssistant("alice", "lawyer"), null);
  await assert.rejects(service.read(""), { code: "LIBRARY_OWNER_REQUIRED" });
});

test("server and page are wired", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /"\/api\/library",\s*requireOwnerSession/u);
  assert.match(read("../src/routes/chat.js"), /getUserLibraryService\(\)\.resolveAssistant\(ownerId, assistant\)/u);
  assert.match(read("../public/prompt-tools.js"), /fetch\("\/api\/library"/u);
});
