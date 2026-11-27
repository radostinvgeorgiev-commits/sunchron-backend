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

test("on an English page the chat's progress, answered-by line and next steps are English", async () => {
  const [script, english] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/locale-en.js", import.meta.url), "utf8"),
  ]);
  const catalog = new Map(
    english
      .split("\n")
      .filter((line) => line.includes("|") && !line.includes("`"))
      .map((line) => line.split("|")),
  );
  // The server's progress lines, each with an English line.
  for (const line of [
    "Проверявам задачата и избирам нужните инструменти…",
    "Изпълнявам задачата с избрания инструмент…",
    "Стъпка {step} от {total}: {capability}",
    "Задачата е изпълнена и проверена.",
    "Задачата чака конкретно потвърждение.",
    "Задачата не можа да бъде изпълнена.",
    "Отговаря агентът",
    "Натисни линка за разрешение по-горе и попитай отново.",
    "Запазването в Google иска еднократно разрешение.",
    "Разреши",
  ]) {
    assert.ok(catalog.has(line), `no English line for "${line}"`);
  }
  assert.match(script, /label\.textContent = taskProgressText\(task\);/u);
  assert.match(script, /step: chatText\("Отвори Дневника на задачите и прегледай причината за неуспешната задача\."\)/u);
  // A missing Google permission points at the allow link, not the journal.
  assert.match(script, /failedSteps\.every\(\(item\) => item\.error === "GOOGLE_SCOPE_REQUIRED"\)/u);
});
