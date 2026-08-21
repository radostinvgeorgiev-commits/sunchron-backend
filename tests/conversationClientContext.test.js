import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser sends bounded visible turns before a short follow-up", async () => {
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const recentHistory = state\.recentConversationMessages\.slice\(-12\);/u,
  );
  assert.match(source, /message: messageText,[\s\S]*recentHistory,/u);
  assert.match(
    source,
    /rememberConversationMessage\("assistant", fullText\);/u,
  );
});
