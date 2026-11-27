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

test("every progress line the task runner streams reaches an English page in English", async () => {
  const { executeTaskPlan } = await import("../src/services/taskExecutionService.js");
  const [script, english, chatRoute, orchestrator] = await Promise.all(
    ["../public/app.js", "../public/locale-en.js", "../src/routes/chat.js", "../src/services/taskOrchestratorService.js"].map(
      (file) => readFile(new URL(file, import.meta.url), "utf8"),
    ),
  );
  const catalog = new Map(
    english
      .split("\n")
      .filter((line) => line.includes("|") && !line.includes("`"))
      .map((line) => line.split("|")),
  );
  // The same lookup and {name} filling as NovariumLocale.text.
  const chatText = (value, values = {}) =>
    (catalog.get(value) ?? value).replace(/\{(\w+)\}/gu, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  const start = script.indexOf("function taskProgressText(");
  const end = script.indexOf("\n}\n", start) + 3;
  const taskProgressText = new Function("chatText", `${script.slice(start, end)}\nreturn taskProgressText;`)(chatText);
  const ok = { output: "x", requiresConfirmation: false, permission: { decision: "allow" }, tool: { id: "t" } };
  const events = [];
  for (const requests of [
    [],
    [{ capability: "calendar.read", action: "google.read", message: "x" }],
    [
      { capability: "calendar.read", action: "google.read", message: "x" },
      { capability: "contacts.read", action: "google.read", message: "x" },
    ],
  ]) {
    await executeTaskPlan({ message: "x", requests, executeFn: async () => ok, notify: (event) => events.push(event) });
  }
  await executeTaskPlan({
    message: "x",
    requests: [
      { capability: "calendar.read", action: "google.read", message: "x" },
      { capability: "youtube.channel", action: "google.read", message: "x" },
    ],
    executeFn: async (capability) => {
      if (capability === "youtube.channel") throw Object.assign(new Error("no"), { code: "GOOGLE_SCOPE_REQUIRED" });
      return ok;
    },
    notify: (event) => events.push(event),
  });
  assert.ok(events.length >= 10);
  for (const event of events) {
    const shown = taskProgressText(event);
    assert.doesNotMatch(shown, /[Ѐ-ӿ]/u, `"${event.message}" is shown as "${shown}"`);
  }
  // The lines the chat route and the planner send themselves.
  const literals = [chatRoute, orchestrator].flatMap((source) =>
    [...source.matchAll(/"((?:Задачата|Проверявам задачата|Novarium обработва задачата)[^"]*)"/gu)].map((match) => match[1]),
  );
  assert.ok(literals.length >= 6);
  for (const line of literals) {
    assert.doesNotMatch(taskProgressText({ message: line }), /[Ѐ-ӿ]/u, `no English line for "${line}"`);
  }
});

test("the Next card keeps the allow step in the chat, and other steps go to the journal", async () => {
  const { JSDOM } = await import("jsdom");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = script.indexOf("function cleanNextStep(");
  const end = script.indexOf("function memoryCandidateCategoryLabel(");
  const { window } = new JSDOM("<div class='assistant-turn'><div class='message'></div><div class='message-actions'></div></div>");
  const saved = [];
  const journal = { setNextStep: (step) => saved.push(step), openCurrentNext() {} };
  const run = (replyText, result) => {
    const turn = window.document.querySelector(".assistant-turn");
    turn.querySelector(".next-step-card")?.remove();
    const showNextStep = new Function(
      "document", "globalThis", "chatText", "renderAgentText", "state", "elements", "resizeChatInput", "sendMessage",
      `${script.slice(start, end)}\nreturn showNextStep;`,
    )(window.document, { SynchronTaskJournal: journal }, (value) => value, () => {}, { chatBusy: false }, {}, () => {}, () => {});
    showNextStep(turn.querySelector(".message"), replyText, result);
    return turn.querySelector(".next-step-card");
  };
  const scope = { status: "failed", error: "GOOGLE_SCOPE_REQUIRED" };
  for (const status of ["failed", "partial"]) {
    const card = run("YouTube is not allowed yet. [Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)", {
      task: { status, steps: [{ status: "completed" }, scope] },
    });
    assert.match(card.textContent, /Натисни линка за разрешение по-горе/u);
    assert.equal(card.querySelectorAll("button").length, 0, `${status}: no journal button`);
  }
  // The answer's own Next line does not take the step to the journal either.
  for (const reply of [
    "I can't see your channel yet.\n\nNext: Allow YouTube, then ask again.",
    "Нямам достъп до канала ти.\n\nСледва: Разреши YouTube и попитай пак.",
  ]) {
    const card = run(reply, { task: { status: "failed", steps: [scope] } });
    assert.match(card.textContent, /Натисни линка за разрешение по-горе/u);
    assert.equal(card.querySelectorAll("button").length, 0, "no journal button");
  }
  assert.deepEqual(saved, [], "the allow step is not saved to the journal");
  const other = run("x", { task: { status: "failed", steps: [{ status: "failed", error: "GOOGLE_API_UNAVAILABLE" }] } });
  assert.equal(other.querySelectorAll("button").length, 1);
  assert.equal(saved.length, 1, "a real failure still goes to the journal");
  window.close();
});
