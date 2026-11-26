import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createFeedbackService, FEEDBACK_COLLECTION } from "../src/services/feedbackService.js";

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async get(collection, id) {
      const data = docs.get(`${collection}/${id}`);
      return data ? { data: structuredClone(data), updateTime: "t" } : null;
    },
    async commitOperations([op]) {
      docs.set(`${op.collection}/${op.id}`, structuredClone(op.data));
    },
  };
}

test("votes are counted per model and month, with no text or account", async () => {
  const store = memoryStore();
  const feedback = createFeedbackService({ store, now: () => Date.parse("2026-11-26T03:00:00Z") });
  await feedback.record({ kind: "up", provider: "claude", model: "claude-haiku-5-5" });
  await feedback.record({ kind: "down", provider: "claude", model: "claude-haiku-5-5" });
  await feedback.record([
    { kind: "win", provider: "gemini", model: "gemini-3.5-flash-lite" },
    { kind: "loss", provider: "claude", model: "claude-haiku-5-5" },
  ]);
  const saved = store.docs.get(`${FEEDBACK_COLLECTION}/2026-11`);
  assert.deepEqual(saved.models["claude:claude-haiku-5-5"], { up: 1, down: 1, win: 0, loss: 1, tie: 0 });
  assert.equal(saved.models["gemini:gemini-3_5-flash-lite"].win, 1);
  assert.deepEqual(Object.keys(saved).sort(), ["models", "month", "updatedAt"]);
  assert.equal((await feedback.summary()).models.length, 2);
});

test("bad votes are refused", async () => {
  const feedback = createFeedbackService({ store: memoryStore() });
  assert.throws(() => feedback.record({ kind: "love", provider: "claude", model: "m" }), { code: "FEEDBACK_INVALID" });
  assert.throws(() => feedback.record({ kind: "up" }), { code: "FEEDBACK_INVALID" });
  assert.throws(() => feedback.record([]), { code: "FEEDBACK_INVALID" });
});

test("the page sends 👍/👎, offers blind comparison and the server mounts both", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const compare = readFileSync(new URL("../public/compare.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  const health = readFileSync(new URL("../src/routes/health.js", import.meta.url), "utf8");
  assert.match(app, /kind: action === "like" \? "up" : "down"/u);
  assert.match(compare, /fetch\("\/chat\/compare"/u);
  assert.match(server, /"\/api\/feedback",\s*requireOwnerSession/u);
  assert.match(chat, /router\.post\("\/compare"/u);
  assert.match(health, /"google-cloud-diagnostics": \{/u);
});
