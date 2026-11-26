import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("application uses the interface language for browser voice input", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="voiceBtn"/u);
  assert.match(script, /webkitSpeechRecognition/u);
  assert.match(script, /recognition\.lang = chatLocale\?\.browserLocale \|\| "bg-BG"/u);
  assert.match(script, /toggleVoiceInput/u);
});

test("talk with voice runs hands-free: listen, send, read aloud, listen again", async () => {
  const [html, script, english] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/locale-en.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="talkBtn"[\s\S]*?fa-headset/u);
  assert.match(script, /function toggleTalkMode\(\)/u);
  // A finished answer is read aloud, then the microphone opens again.
  assert.match(script, /if \(talkReply && state\.talkMode\) talkSpeak\(talkReply\);/u);
  assert.match(script, /state\.talkTimer = setTimeout\(talkListen, 350\)/u);
  // Saying "стоп" ends it, and so does silence three times in a row.
  assert.match(script, /TALK_STOP_WORDS = \/\^\(стоп\|спри\|край/u);
  assert.match(script, /TALK_MAX_EMPTY = 3/u);
  // An error or a pressed "Спри" ends the conversation instead of looping.
  assert.match(script, /\} catch \(error\) \{\n    stopTalkMode\(\);\n    if \(abort\.signal\.aborted\)/u);
  // Recording on the server (iPhone) stops by itself after a pause.
  assert.match(script, /function watchForSilence\(stream, recorder\)/u);
  assert.match(english, /Разговор с глас\|Talk with voice/u);
});
