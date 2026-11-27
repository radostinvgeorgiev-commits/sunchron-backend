import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, styles, chatRoute] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/routes/chat.js", import.meta.url), "utf8"),
]);

// The page's Next-step functions, run with a chatText catalog ({} is the
// Bulgarian page).
function nextStepFunctions(catalog = {}) {
  const start = app.indexOf("function cleanNextStep(");
  const end = app.indexOf("function showNextStep(");
  assert.ok(start > 0 && end > start);
  return new Function(
    "chatText",
    `${app.slice(start, end)}\nreturn { nextStepFromReply, localizedNextLines, resolveNextStep, answerNextLineIndex };`,
  )((value) => catalog[value] ?? value);
}
const ENGLISH_PAGE = {
  Следва: "Next",
  "Натисни линка за разрешение по-горе и попитай отново.": "Use the allow link above, then ask again.",
};
// A German page: chatText turns the Bulgarian text into its English one
// (locale-en.js) and that into German (locales/de.json), as locale.js does.
const GERMAN_PAGE = await Promise.all([
  readFile(new URL("../public/locale-en.js", import.meta.url), "utf8"),
  readFile(new URL("../public/locales/de.json", import.meta.url), "utf8"),
]).then(([english, german]) => {
  const toEnglish = new Map(
    english
      .split("\n")
      .filter((line) => line.includes("|") && !line.includes("`"))
      .map((line) => line.split("|")),
  );
  return { Следва: JSON.parse(german)[toEnglish.get("Следва")] };
});

test("всеки завършен AI отговор показва една следваща стъпка", () => {
  assert.match(app, /function showNextStep\(/u);
  assert.match(app, /showNextStep\(responseBubble, fullText, parsed\.data\)/u);
  assert.match(app, /Следва/u);
  assert.match(styles, /\.next-step-card/u);
});

test("следващата стъпка се свързва с Дневника на задачите", () => {
  assert.match(app, /SynchronTaskJournal\?\.setNextStep/u);
  assert.match(app, /SynchronTaskJournal\?\.openCurrentNext/u);
  assert.match(app, /Отвори в Дневника/u);
});

test("AI CORE формулира конкретната стъпка в машинно разпознаваем ред", () => {
  assert.match(chatRoute, /Следва: конкретна стъпка/u);
  assert.match(chatRoute, /При поздрав, кратък въпрос или разговор не добавяй такъв ред/u);
  assert.match(chatRoute, /Никога не измисляй кодове, номера/u);
});

test("свободен текст от модела не се записва сам в Дневника", () => {
  assert.match(app, /fromStructuredResult/u);
  assert.match(app, /Добави в Дневника/u);
  assert.doesNotMatch(app, /Продължи с една конкретна задача по този отговор/u);
});

test("Council без собствен nextSteps показва конкретното защитено действие", () => {
  assert.match(app, /result\?\.mode === "council"/u);
  assert.match(app, /натисни „Изпълни препоръката“/u);
});

test("a failed sign-in offers registration with the same email", () => {
  assert.match(app, /error\.code === "AUTH_INVALID_CREDENTIALS" && state\.registrationEnabled/u);
  assert.match(app, /Създай профил с този имейл/u);
  assert.match(app, /най-вероятно още нямаш профил/u);
});

test("a single-advisor Council answer is shown once", async () => {
  const { formatAiCouncilReply } = await import("../src/services/aiCouncilService.js");
  const reply = formatAiCouncilReply({
    responses: [{ provider: "claude", model: "claude-haiku-5-5", text: "Отговор." }],
    recommendation: "Отговор.",
    rationale: "x",
  });
  assert.equal(reply.match(/Отговор\./gu).length, 1);
  assert.doesNotMatch(reply, /Обща препоръка/u);
});

test("registration explains a short password instead of silently not submitting", () => {
  assert.match(app, /registerForm\.noValidate = true/u);
  assert.match(app, /Паролата трябва да е поне 8 знака/u);
});

test("each remembered fact shows when it was saved and who confirmed it", () => {
  assert.match(app, /function memoryProvenance\(item\)/u);
  assert.match(app, /потвърдено от теб/u);
  assert.match(app, /Нищо не се записва без твое „да“/u);
});

test("a missing Google permission points at the allow link and stays out of the journal", () => {
  const { resolveNextStep } = nextStepFunctions();
  const scopeOnly = { status: "failed", error: "GOOGLE_SCOPE_REQUIRED" };
  const allow = "Натисни линка за разрешение по-горе и попитай отново.";
  // Failed, or partly done with only the permission missing: the allow link.
  for (const status of ["failed", "partial"]) {
    const next = resolveNextStep("YouTube is not allowed yet.", {
      task: { status, steps: [{ status: "completed" }, scopeOnly] },
    });
    assert.equal(next.step, allow);
    assert.equal(next.chatOnly, true);
  }
  // Any other failure still goes to the journal.
  const other = resolveNextStep("x", {
    task: { status: "partial", steps: [scopeOnly, { status: "failed", error: "GOOGLE_API_UNAVAILABLE" }] },
  });
  assert.match(other.step, /Дневника/u);
  assert.equal(other.chatOnly, undefined);
  // The allow step is neither saved to the journal nor offered as a journal button.
  assert.match(app, /if \(fromStructuredResult && !next\.chatOnly\) \{/u);
  assert.match(app, /if \(!next\.chatOnly\) card\.append\(openButton\);/u);
});

test("an English page reads an English Next line and never shows a Bulgarian one", () => {
  const english = nextStepFunctions(ENGLISH_PAGE);
  // The model's English last line becomes the Next card.
  assert.deepEqual(english.nextStepFromReply("Your channel has 12 videos.\n\nNext: Allow YouTube."), {
    step: "Allow YouTube.",
    displayText: "Your channel has 12 videos.",
  });
  // A Bulgarian marker that is not the last line is shown as "Next".
  assert.equal(
    english.nextStepFromReply("Answer.\n\n**Следва:** Allow YouTube.\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)").displayText,
    "Answer.\n\n**Next:** Allow YouTube.\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)",
  );
  assert.equal(english.localizedNextLines("Answer.\n- Следваща стъпка: X"), "Answer.\n- Next: X");
  // A Bulgarian page keeps its own label, and the text otherwise stays as it is.
  const bulgarian = nextStepFunctions();
  assert.equal(bulgarian.localizedNextLines("Отговор.\nСледва: X\nОще"), "Отговор.\nСледва: X\nОще");
  assert.equal(bulgarian.nextStepFromReply("Отговор.\nСледва: Провери.").step, "Провери.");
  // A restored conversation shows the label in the page language too.
  assert.match(app, /item\.role === "assistant" \? localizedNextLines\(item\.content\) : item\.content/u);
});

test("only a capitalised English Next line is a Next line, so code is never one", () => {
  const english = nextStepFunctions(ENGLISH_PAGE);
  const bulgarian = nextStepFunctions();
  // "Next:", "Next step:" and "**Следва:**" (in any case) still are.
  assert.deepEqual(english.nextStepFromReply("Done.\n\nNext: Call Ana."), { step: "Call Ana.", displayText: "Done." });
  assert.equal(english.nextStepFromReply("Done.\n- **Next Step:** Call Ana.").step, "Call Ana.");
  assert.deepEqual(bulgarian.nextStepFromReply("Готово.\n\n**Следва:** Обади се на Ана."), {
    step: "Обади се на Ана.",
    displayText: "Готово.",
  });
  assert.equal(bulgarian.nextStepFromReply("Готово.\nследва: Обади се.").step, "Обади се.");
  // A lowercase "next:" (a TypeScript field, an iterator) is not.
  for (const reply of ["Use it like this:\nnext: x", "const it = {\n  next: () => ({ done: true }),"]) {
    assert.deepEqual(english.nextStepFromReply(reply), { step: "", displayText: reply });
  }
  // Neither is a "Next:" line inside a ``` code block.
  assert.equal(english.nextStepFromReply("Config:\n```yaml\nNext: page-2").step, "");
});

test("a one-line ```code``` does not open a code block, so the Next line after it still counts", () => {
  assert.deepEqual(nextStepFunctions().nextStepFromReply("Пусни:\n```npm test```\nСледва: провери ЛИПА-742."), {
    step: "провери ЛИПА-742.",
    displayText: "Пусни:\n```npm test```",
  });
  // A fence with an info string still opens a block, and a bare one closes it.
  const english = nextStepFunctions(ENGLISH_PAGE);
  assert.equal(english.nextStepFromReply("Run:\n  ```bash\nNext: x\n  ```").step, "");
  assert.equal(english.nextStepFromReply("Run:\n```bash\nnpm test\n```\nNext: Check the result.").step, "Check the result.");
});

test("a fence in a list item, or closed by a longer run, leaves the Next line after it for the Next card", () => {
  const bulgarian = nextStepFunctions();
  assert.deepEqual(
    bulgarian.nextStepFromReply("Пусни тестовете така:\n- ```bash\n  npm test\n  ```\n\nСледва: Провери задача ЛИПА-742."),
    { step: "Провери задача ЛИПА-742.", displayText: "Пусни тестовете така:\n- ```bash\n  npm test\n  ```" },
  );
  assert.deepEqual(
    bulgarian.nextStepFromReply("Ето кода:\n```js\nrun();\n````\nСледва: Пусни го и ми кажи ЛИПА-742."),
    { step: "Пусни го и ми кажи ЛИПА-742.", displayText: "Ето кода:\n```js\nrun();\n````" },
  );
  // Inside such blocks, Next-looking lines and a shorter "```" line are code.
  const english = nextStepFunctions(ENGLISH_PAGE);
  for (const code of ["Config:\n- ```yaml\n  Next: page-2\n  ```", "Example:\n````md\n```\nNext: x\n```\n````"]) {
    assert.deepEqual(english.nextStepFromReply(code), { step: "", displayText: code });
  }
});

// Code fences as CommonMark (and marked) reads them, and the Next lines
// outside code.
const FENCE_CASES = [
  // A fence after a list marker opens a block; the item's indented closing
  // fence closes it.
  ["Пусни тестовете така:\n- ```bash\n  npm test\n  ```\n\nСледва: Провери задача ЛИПА-742.", [5]],
  ["Config:\n- ```yaml\n  Next: page-2\n  limit: 10\n  ```\nГотово.", []],
  ["1. ```bash\n   Next: x\n   ```\n2) ```\n   Next: y\n   ```\nNext: z", [6]],
  ["* ```\n  Следва: a\n  ```\n+ ```js\n  Следва: b\n  ```\nСледва: c", [6]],
  ["  - ```bash\n    echo\n    ```\nNext: y", [3]],
  ["-\t```bash\n\tnpm test\n\t```\nNext: y", [3]],
  // A longer closing run closes a block; a shorter one inside a longer block,
  // or one with an info string, is code.
  ["Ето кода:\n```js\nrun();\n````\nСледва: Пусни го и ми кажи ЛИПА-742.", [4]],
  ["Example:\n````md\n```\nNext: x\n```\n````\nDone.\nNext: Check it.", [7]],
  ["```\nNext: x\n``` js\nNext: y\n```\nNext: z", [5]],
  ["```js\r\ncode\r\n```  \r\nNext: done", [3]],
  // Not fences: code on one line, a marker without a space, ten digits, a quote.
  ["Пусни:\n```npm test```\nСледва: провери ЛИПА-742.", [2]],
  ["-```bash\nСледва: x", [1]],
  ["1234567890. ```\nNext: x", [1]],
  ["> ```js\n> Next: x\n> ```\nNext: y", [3]],
  // A block that is not closed runs to the end.
  ["Run:\n  ```bash\nNext: x", []],
  // Every Next line outside code counts; the page takes the last one.
  ["Next: first\nText\n**Следва:** last", [0, 2]],
];

test("the server and the page find the same Next lines outside the same code blocks", async () => {
  const { nextStepLineIndexes } = await import("../src/services/projectConversationContextService.js");
  const { answerNextLineIndex } = nextStepFunctions();
  // The page gives the last Next line; asked for each line with the lines
  // above it, it gives every one.
  const pageIndexes = (lines) =>
    lines.flatMap((line, index) => (answerNextLineIndex(lines.slice(0, index + 1)) === index ? [index] : []));
  for (const [text, expected] of FENCE_CASES) {
    const lines = text.split("\n");
    assert.deepEqual(nextStepLineIndexes(lines), expected, text);
    assert.equal(answerNextLineIndex(lines), expected.at(-1) ?? -1, text);
    assert.deepEqual(pageIndexes(lines), expected, text);
  }
  // And every answer of up to four lines made of these agrees too.
  const vocabulary = ["```js", "```", "````", "- ```bash", "  ```", "``` js", "```npm test```", "Next: x", "**Следва:** y", "text"];
  let answers = [[]];
  for (let length = 1; length <= 4; length += 1) {
    answers = answers.flatMap((lines) => vocabulary.map((line) => [...lines, line]));
    for (const lines of answers) assert.deepEqual(pageIndexes(lines), nextStepLineIndexes(lines), lines.join("\n"));
  }
});

test("a link only in the answer's own Next line stays in the text above the Next card", async () => {
  const { withGoogleAllowLinks } = await import("../src/routes/chat.js");
  const { GoogleDriveError } = await import("../src/services/googleDriveService.js");
  const url = "https://cloudaicore.com/api/google/connect?add=youtube";
  const notAllowed = {
    status: "rejected",
    request: { capability: "youtube.channel" },
    error: new GoogleDriveError(`YouTube още не е разрешен. [Свържи YouTube](${url}).`, 403, "GOOGLE_SCOPE_REQUIRED"),
  };
  const result = { task: { status: "failed", steps: [{ status: "failed", error: "GOOGLE_SCOPE_REQUIRED" }] } };
  for (const [language, catalog, answer, step] of [
    [
      "en",
      ENGLISH_PAGE,
      `I can't see your YouTube channel yet.\n\nNext: [Allow YouTube](${url}), then ask me again.`,
      "Use the allow link above, then ask again.",
    ],
    [
      "bg",
      {},
      `Още нямам достъп до канала ти в YouTube.\n\nСледва: [Свържи YouTube](${url}) и ме попитай пак.`,
      "Натисни линка за разрешение по-горе и попитай отново.",
    ],
  ]) {
    const reply = withGoogleAllowLinks(answer, [notAllowed], language);
    const next = nextStepFunctions(catalog).resolveNextStep(reply, result);
    assert.equal(next.step, step, language);
    assert.equal(next.chatOnly, true, language);
    assert.ok(next.displayText.includes(url), `${language}: the allow link is shown`);
  }
});

test("a missing Google permission stays out of the journal even when the answer has its own Next line", () => {
  const scopeOnly = { status: "failed", steps: [{ status: "failed", error: "GOOGLE_SCOPE_REQUIRED" }] };
  assert.deepEqual(
    nextStepFunctions().resolveNextStep("Нямам достъп до канала ти.\n\nСледва: Разреши YouTube и попитай пак.", {
      task: scopeOnly,
    }),
    {
      step: "Натисни линка за разрешение по-горе и попитай отново.",
      displayText: "Нямам достъп до канала ти.",
      chatOnly: true,
    },
  );
  assert.deepEqual(
    nextStepFunctions(ENGLISH_PAGE).resolveNextStep(
      "I can't see your channel yet.\n\nNext: Allow YouTube, then ask again.",
      { task: scopeOnly },
    ),
    {
      step: "Use the allow link above, then ask again.",
      displayText: "I can't see your channel yet.",
      chatOnly: true,
    },
  );
  // Another failure next to the missing permission still goes to the journal.
  const other = nextStepFunctions().resolveNextStep("Част от задачата е готова.", {
    task: {
      status: "partial",
      steps: [
        { status: "failed", error: "GOOGLE_SCOPE_REQUIRED" },
        { status: "failed", error: "GOOGLE_API_UNAVAILABLE" },
      ],
    },
  });
  assert.equal(other.step, "Отвори Дневника на задачите и продължи първата незавършена стъпка.");
  assert.equal(other.chatOnly, undefined);
});

test("only the answer's own Next line is relabelled, never a text the person asked for or code", () => {
  const english = nextStepFunctions(ENGLISH_PAGE);
  const body = "Here is the Bulgarian version:\n\nГотово: докладът.\nСледва: обади се на клиента.\nПо-късно: фактурата.";
  const translation = `${body}\n\nNext: Send the translation to the team.`;
  assert.equal(english.localizedNextLines(translation), translation);
  assert.deepEqual(english.nextStepFromReply(translation), {
    step: "Send the translation to the team.",
    displayText: body,
  });
  // A "Следва:" line inside a code block never changes.
  const code = "Example:\n```\nСледва: X\n```";
  assert.equal(english.localizedNextLines(code), code);
  assert.equal(english.nextStepFromReply(code).displayText, code);
  // The answer's own line after the code block is relabelled; the code is not.
  assert.equal(
    english.localizedNextLines(`${code}\n**Следва:** Y\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)`),
    `${code}\n**Next:** Y\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)`,
  );
  // A translation usually has no Next line of its own: its "Следва:" line is
  // followed by more of the text, so it is not the answer's and stays.
  assert.equal(english.localizedNextLines(body), body);
  assert.deepEqual(english.nextStepFromReply(body), { step: "", displayText: body });
  assert.equal(
    english.resolveNextStep(body, { task: { status: "failed", steps: [{ status: "failed", error: "GOOGLE_API_UNAVAILABLE" }] } })
      .displayText,
    body,
  );
  // Only blank lines after it: it is where the answer's own line goes.
  assert.equal(english.localizedNextLines("Answer.\nСледва: X\n\n"), "Answer.\nNext: X\n\n");
});

// Restores the stored turns on a page with the given chatText catalog, and
// gives what the page shows, logs and remembers.
async function restoreOnPage(catalog, stored) {
  const { JSDOM } = await import("jsdom");
  const { window } = new JSDOM("<div id='chat'></div>");
  const slice = (from, to) => {
    const start = app.indexOf(from);
    const end = app.indexOf(to);
    assert.ok(start > 0 && end > start, `${from} … ${to}`);
    return app.slice(start, end);
  };
  const shown = [];
  const logged = [];
  const state = { sessionId: "chat-1", recentConversationMessages: [] };
  const restoreConversation = new Function(
    "document",
    "state",
    "elements",
    "fetch",
    "chatText",
    "localizedMarkup",
    "createAssistantTurn",
    "logAction",
    "showWelcomeMessage",
    [
      slice("function cleanNextStep(", "function showNextStep("),
      slice("function rememberConversationMessage(", "async function checkHealth("),
      slice("async function restoreConversation(", "async function startNewChat("),
      "return restoreConversation;",
    ].join("\n"),
  )(
    window.document,
    state,
    { chatMessages: window.document.getElementById("chat") },
    async () => ({ ok: true, json: async () => ({ items: stored }) }),
    (value) => catalog[value] ?? value,
    (value) => value,
    (text) => {
      shown.push(text);
      return { message: window.document.createElement("div") };
    },
    (action) => logged.push(action),
    async () => logged.push("welcome"),
  );
  await restoreConversation();
  const users = [...window.document.querySelectorAll(".message.user")].map((node) => node.textContent);
  window.close();
  return { shown, logged, users, remembered: state.recentConversationMessages };
}

test("a restored answer shows the page's Next label, and the history sent back keeps the stored text", async () => {
  // The relabelled text is only shown; the stored text is remembered, so the
  // server can match it to the saved turns and strip its "Следва:" line.
  assert.match(
    app,
    /localizedNextLines\(item\.content\) : item\.content,\s*null,\s*\{ remember: false \},\s*\);\s*rememberConversationMessage\(item\.role, item\.content\);/u,
  );
  // A translation with a "Следва:" line inside it, and no Next line of its own.
  const translation =
    "Here is the Bulgarian version:\n\nГотово: докладът.\nСледва: обади се на клиента.\nПо-късно: фактурата.";
  const stored = [
    { role: "user", content: "Show my channel" },
    { role: "assistant", content: "I need YouTube access first.\n\nСледва: Разреши YouTube.\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)" },
    { role: "user", content: "Done" },
    { role: "assistant", content: "Your channel has 12 videos." },
    { role: "user", content: "Translate the plan into Bulgarian" },
    { role: "assistant", content: translation },
  ];
  const { shown, logged, users, remembered } = await restoreOnPage(ENGLISH_PAGE, stored);
  assert.deepEqual(logged, ["Възстановена е историята на разговора"]);
  assert.deepEqual(shown, [
    "I need YouTube access first.\n\nNext: Разреши YouTube.\n\n[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)",
    "Your channel has 12 videos.",
    translation,
  ]);
  assert.deepEqual(users, ["Show my channel", "Done", "Translate the plan into Bulgarian"]);
  assert.deepEqual(remembered, stored);
});

test("on a German page the answer's own English Next line gets the page's label, as the Next card does", async () => {
  assert.equal(GERMAN_PAGE.Следва, "Weiter");
  const german = nextStepFunctions(GERMAN_PAGE);
  // The server asks for "Next:" on every page but a Bulgarian one; the live
  // answer's last line becomes the card, labelled "Weiter".
  const answer = "Der Termin um 10 Uhr ist frei.\n\nNext: Prüfe den Termin um 10 Uhr.";
  assert.deepEqual(german.nextStepFromReply(answer), {
    step: "Prüfe den Termin um 10 Uhr.",
    displayText: "Der Termin um 10 Uhr ist frei.",
  });
  // Restored, the same line shows that label too, and so does an own
  // "Следва:" line, also above an allow line.
  const allow = "[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)";
  assert.equal(german.localizedNextLines(answer), "Der Termin um 10 Uhr ist frei.\n\nWeiter: Prüfe den Termin um 10 Uhr.");
  assert.equal(german.localizedNextLines("Antwort.\n\nСледва: Erlaube YouTube."), "Antwort.\n\nWeiter: Erlaube YouTube.");
  assert.equal(german.localizedNextLines(`Antwort.\n- **Next step:** Y\n\n${allow}`), `Antwort.\n- **Weiter:** Y\n\n${allow}`);
  // A translation's "Следва:" line in the middle of its text, a Next line
  // inside code and an earlier Next line stay as they are.
  const translation = "Hier ist die bulgarische Fassung:\n\nГотово: докладът.\nСледва: обади се на клиента.\nПо-късно: фактурата.";
  const code = "Beispiel:\n```yaml\nNext: page-2\n```";
  for (const text of [translation, code, "Next: zuerst das.\nDann der Rest."]) {
    assert.equal(german.localizedNextLines(text), text);
  }
  assert.equal(
    german.localizedNextLines(`${code}\nNext: Ruf Ana an.`),
    `${code}\nWeiter: Ruf Ana an.`,
  );
  // An English page keeps its English lines as they are, and a Bulgarian
  // page changes nothing.
  for (const text of [answer, `Antwort.\n- **Next step:** Y\n\n${allow}`]) {
    assert.equal(nextStepFunctions(ENGLISH_PAGE).localizedNextLines(text), text);
    assert.equal(nextStepFunctions().localizedNextLines(text), text);
  }
  // A restored conversation on a German page.
  const stored = [
    { role: "user", content: "Ist um 10 Uhr frei?" },
    { role: "assistant", content: answer },
    { role: "user", content: "Übersetze den Plan ins Bulgarische" },
    { role: "assistant", content: translation },
  ];
  const { shown, remembered } = await restoreOnPage(GERMAN_PAGE, stored);
  assert.deepEqual(shown, ["Der Termin um 10 Uhr ist frei.\n\nWeiter: Prüfe den Termin um 10 Uhr.", translation]);
  assert.deepEqual(remembered, stored);
});
