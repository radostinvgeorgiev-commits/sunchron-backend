import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("application supports Bulgarian browser voice input", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="voiceBtn"/u);
  assert.match(script, /webkitSpeechRecognition/u);
  assert.match(script, /recognition\.lang = ["']bg-BG["']/u);
  assert.match(script, /toggleVoiceInput/u);
});
