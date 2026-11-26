import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";

import {
  createShareService,
  isShareToken,
  snapshotMessages,
  SHARE_COLLECTION,
} from "../src/services/shareService.js";
import { createShareRouter, createSharedReadRouter } from "../src/routes/shareRouter.js";

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
        const key = `${op.collection}/${op.id}`;
        if (op.type === "delete") docs.delete(key);
        else docs.set(key, structuredClone(op.data));
      }
    },
  };
}

const conversations = {
  "alice:s1": [
    { role: "user", content: "Как да сготвя боб?", ownerId: "alice", sessionId: "s1" },
    { role: "assistant", content: "Накисни го от вечерта.", ownerId: "alice" },
    { role: "system", content: "скрито" },
  ],
};
let counter = 0;
const tokens = () => `${String(++counter).padStart(2, "0")}${"a".repeat(30)}`;

function service(store = memoryStore()) {
  return createShareService({
    store,
    listMessages: async (sessionId, ownerId) => conversations[`${ownerId}:${sessionId}`] || [],
    newToken: tokens,
    now: () => Date.parse("2026-11-26T00:00:00Z"),
  });
}

test("a link holds a copy of only user and assistant text", async () => {
  const store = memoryStore();
  const shares = service(store);
  const created = await shares.create({ ownerId: "alice", sessionId: "s1" });
  assert.ok(isShareToken(created.token));
  const shared = await shares.read(created.token);
  assert.equal(shared.title, "Как да сготвя боб?");
  assert.deepEqual(shared.messages, [
    { role: "user", content: "Как да сготвя боб?" },
    { role: "assistant", content: "Накисни го от вечерта." },
  ]);
  assert.doesNotMatch(JSON.stringify([...store.docs.values()]), /ownerId|alice|скрито/u);
});

test("a new link replaces the old one and stopping removes the copy", async () => {
  const store = memoryStore();
  const shares = service(store);
  const first = await shares.create({ ownerId: "alice", sessionId: "s1" });
  const second = await shares.create({ ownerId: "alice", sessionId: "s1" });
  assert.equal(await shares.read(first.token), null);
  assert.ok(await shares.read(second.token));
  assert.deepEqual(await shares.status({ ownerId: "alice", sessionId: "s1" }), {
    shared: true,
    token: second.token,
  });
  await shares.remove({ ownerId: "alice", sessionId: "s1" });
  assert.equal(await shares.read(second.token), null);
  assert.equal([...store.docs.keys()].filter((key) => key.startsWith(SHARE_COLLECTION)).length, 0);
});

test("someone else's conversation or an empty one cannot be shared", async () => {
  const shares = service();
  await assert.rejects(shares.create({ ownerId: "bob", sessionId: "s1" }), { code: "SHARE_EMPTY" });
  await assert.rejects(shares.create({ ownerId: "alice", sessionId: "" }), { code: "SHARE_SESSION_REQUIRED" });
  assert.deepEqual(await shares.status({ ownerId: "bob", sessionId: "s1" }), { shared: false });
});

test("bad tokens are refused without a lookup and snapshots are capped", async () => {
  const shares = service();
  for (const token of ["", "short", "../../etc", "a".repeat(33), "session-abc"]) {
    assert.equal(await shares.read(token), null);
  }
  const many = Array.from({ length: 300 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.equal(snapshotMessages(many).length, 200);
});

test("routes: owner endpoints use the signed-in owner, public read is noindex", async () => {
  const shares = service();
  const app = express();
  app.use(express.json());
  app.use("/api/share", (req, _res, next) => {
    req.owner = { memoryOwnerId: "alice" };
    next();
  }, createShareRouter({ service: shares }));
  app.use("/api/shared", createSharedReadRouter({ service: shares }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const made = await (await fetch(`${base}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    })).json();
    assert.match(made.url, /\/s\/[A-Za-z0-9_-]{32}$/u);
    const token = made.url.split("/s/")[1];
    const read = await fetch(`${base}/api/shared/${token}`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal((await read.json()).messages.length, 2);
    await fetch(`${base}/api/share/s1`, { method: "DELETE" });
    assert.equal((await fetch(`${base}/api/shared/${token}`)).status, 404);
  } finally {
    server.close();
  }
});

test("server mounts the share routes and the page uses no inline script", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const page = readFileSync(new URL("../public/shared.html", import.meta.url), "utf8");
  assert.match(server, /"\/api\/share",\s*requireOwnerSession/);
  assert.match(server, /app\.get\("\/s\/:token"/);
  assert.doesNotMatch(page, /<script>(?!<\/script>)/);
  assert.match(page, /noindex/);
});
