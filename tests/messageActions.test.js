import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/ui-refresh.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");

test("answers offer retry and retry with another model", () => {
  assert.match(app, /data-action="retry"/);
  assert.match(app, /data-action="retry-model"/);
  assert.match(app, /function openRetryModelMenu/);
  assert.match(css, /\.assistant-turn:not\(:last-child\) \.retry-action \{ display: none; \}/);
});

test("sent messages can be edited and resent", () => {
  assert.match(app, /data-action="edit"/);
  assert.match(app, /function startEditingMessage/);
  assert.match(app, /turn\.__request = \{ text, image \}/);
});

test("retry and edit trim the history and ask the server not to bring the old turns back", async () => {
  assert.match(app, /function resendFrom\(userTurn, request, modelOverride = ""\)/);
  assert.match(app, /\.\.\.\(resend \? \{ rewrite: true \} : \{\}\)/);
  assert.match(chat, /effectiveConversationHistory\(history, recentHistory, \{\s*rewrite: rewrite === true,\s*\}\)/);
  // The saved turns that the page's turns continue are merged back, except
  // when the page asks for a rewrite.
  const { effectiveConversationHistory } = await import("../src/routes/chat.js");
  const saved = [
    { role: "user", content: "Първи въпрос" },
    { role: "assistant", content: "Първи отговор" },
    { role: "user", content: "Втори въпрос" },
    { role: "assistant", content: "Стар отговор" },
  ];
  const shown = saved.slice(2);
  assert.deepEqual(effectiveConversationHistory(saved, shown), saved);
  assert.deepEqual(effectiveConversationHistory(saved, shown, { rewrite: true }), shown);
});

test("the send button becomes Stop while an answer streams", () => {
  assert.match(app, /signal: abort\.signal/);
  assert.match(app, /function stopGeneration\(\)/);
  assert.match(app, /if \(state\.chatBusy\) stopGeneration\(\);/);
  assert.match(app, /fa-solid fa-stop/);
});

test("council answers render as side-by-side cards", () => {
  assert.match(app, /function showCouncilColumns/);
  assert.match(app, /showCouncilColumns\(responseBubble, parsed\.data\?\.council\)/);
  assert.match(css, /\.council-columns \{/);
  assert.match(css, /scroll-snap-type: x mandatory/);
});
