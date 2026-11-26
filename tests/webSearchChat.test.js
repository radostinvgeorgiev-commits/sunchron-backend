import test from "node:test";
import assert from "node:assert/strict";

import { createWebSearchChatHandler } from "../src/routes/chat.js";

function call(handler, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    handler({ body, owner: { memoryOwnerId: "owner" } }, res);
  });
}

test("search answers with sources, reserves budget and saves the turn", async () => {
  const calls = [];
  const handler = createWebSearchChatHandler({
    reserve: async (...args) => calls.push(["reserve", ...args]),
    search: async (query) => ({ text: `Отговор за ${query}`, sources: [{ title: "A", url: "https://a.example", extra: 1 }] }),
    saveTurn: async (...args) => calls.push(["save", ...args]),
  });
  const { status, body } = await call(handler, { message: "новини", sessionId: "sess-1" });
  assert.equal(status, 200);
  assert.deepEqual(body, { text: "Отговор за новини", sources: [{ title: "A", url: "https://a.example" }] });
  assert.equal(calls[0][0], "reserve");
  assert.match(calls[1][3], /Източници:\n• \[A\]\(https:\/\/a\.example\)/u);
  assert.equal(calls[1][4], "owner");
});

test("bad input and out-of-credit errors are returned plainly", async () => {
  const ok = { search: async () => ({ text: "x", sources: [] }), saveTurn: async () => {} };
  assert.equal((await call(createWebSearchChatHandler(ok), { message: "", sessionId: "s" })).body.code, "SEARCH_MESSAGE_INVALID");
  assert.equal((await call(createWebSearchChatHandler(ok), { message: "x", sessionId: "../x" })).body.code, "CHAT_SESSION_INVALID");
  const denied = await call(
    createWebSearchChatHandler({
      ...ok,
      reserve: async () => {
        throw Object.assign(new Error("Кредитите свършиха."), { status: 402, code: "AI_CREDITS_EXHAUSTED" });
      },
    }),
    { message: "x", sessionId: "s" },
  );
  assert.deepEqual([denied.status, denied.body.code], [402, "AI_CREDITS_EXHAUSTED"]);
});
