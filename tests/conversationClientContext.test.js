import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser sends bounded visible turns before a short follow-up", async () => {
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );

  // The last 12 turns, and the page's own picture and clip lines among them
  // (review r2: a full card pushed the conversation out).
  assert.match(
    source,
    /const recentHistory = conversationWindow\(state\.recentConversationMessages\);/u,
  );
  assert.match(source, /const RECENT_TURNS = 12;\nconst RECENT_PAGE_LINES = 24;/u);
  assert.match(source, /message: messageText,[\s\S]*recentHistory,/u);
  assert.match(
    source,
    /rememberConversationMessage\("assistant", fullText\);/u,
  );
});
