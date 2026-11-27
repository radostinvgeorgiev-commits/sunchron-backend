import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
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
    `${app.slice(start, end)}\nreturn { nextStepFromReply, localizedNextLines, resolveNextStep, answerNextLineIndex, nextLineCodeBlocks };`,
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

test("Novarium формулира конкретната стъпка в машинно разпознаваем ред", () => {
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

// Answers the rule knowingly reads otherwise than marked (KNOWN_DIFFERENCES).
// A heredoc with a blank line in a list step after a step whose code was
// written unindented.
const HEREDOC_AFTER_UNINDENTED_STEP = [
  "1. Инсталирай зависимостите:",
  "   ```bash",
  "npm install express",
  "   ```",
  "2. Създай `README.md`:",
  "   ```bash",
  "   cat > README.md <<'EOF'",
  "# Synchron",
  "",
  "Асистент за проекти.",
  "EOF",
  "   ```",
  "",
  "Следва: Пусни `npm start` и ми кажи какво пише.",
].join("\n");
// The same after a step whose unindented code has a blank line.
const HEREDOC_AFTER_UNINDENTED_BLANK_STEP = [
  "1. Създай `server.js`:",
  "   ```js",
  'const express = require("express");',
  "",
  "const app = express();",
  "app.listen(3000);",
  "   ```",
  "2. Създай `README.md`:",
  "   ```bash",
  "   cat > README.md <<'EOF'",
  "# Synchron",
  "",
  "Асистент за проекти.",
  "EOF",
  "   ```",
  "",
  "Следва: Пусни `node server.js` и ми кажи какво пише.",
].join("\n");
// A fenced JSON example in a Python string, in a list step whose code was
// written unindented.
const FENCE_IN_UNINDENTED_PYTHON = [
  "- Install:",
  "    ```python",
  'PROMPT = """',
  "Return the result as JSON in a fenced block:",
  "```json",
  '{"ok": true}',
  "```",
  '"""',
  "    ```",
  "Next step: Commit the change.",
].join("\n");
// The same with the step's closing fence at the step's text, and a blank line
// before the Next line.
const FENCE_IN_UNINDENTED_PYTHON_AT_ITEM = [
  "1. Install:",
  "   ```python",
  'PROMPT = """',
  "```json",
  '{"ok": true}',
  "```",
  '"""',
  "   ```",
  "",
  "Следва: Пусни тестовете и ми кажи резултата.",
].join("\n");
// Unindented HTML in a bare fence of a list step.
const BARE_FENCE_HTML = [
  "1. Добави картата в `index.html`:",
  "   ```",
  '<div class="card">',
  "  <h1>Заглавие</h1>",
  "</div>",
  "   ```",
  "",
  "Следва: Отвори страницата и ми кажи как изглежда.",
].join("\n");
// A closing fence seven columns in, four past the item's text.
const OVER_INDENTED_CLOSER = "1. Install:\n   ```bash\n   npm install\n       ```\nСледва: x";
// Three steps of a list whose text starts four columns in, with code and
// closing fences at column 0, the second step's fence bare on its own line.
const FOUR_COLUMN_THREE_STEPS = [
  "1.  Създай `app.py`:",
  "    ```python",
  "import os",
  "",
  'print(os.environ["PORT"])',
  "```",
  "2.  Създай `.env`:",
  "    ```",
  "PORT=8080",
  "```",
  "3.  Пусни:",
  "    ```bash",
  "python app.py",
  "```",
  "",
  "Следва: Кажи ми какво пише.",
].join("\n");

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
  // A "```" line indented four or more columns past the opening line's text
  // is code: in a Python string, a README example or a tab-indented line.
  ['```python\nprompt = """\n    ```json\n    {}\n    ```\n"""\n```\nNext: run it', [7]],
  ["```markdown\nExample:\n\n    ```\n    code\n    ```\n```\nNext: x", [7]],
  ["Code:\n  ```md\n      ```\n  ```\nNext: x", [4]],
  ["```js\ncode\n\t```\nNext: x\n```\nNext: y", [5]],
  ["1. Run:\n   ```bash\n   npm test\n    ```\nNext: x", [4]],
  // A closing fence may end in spaces, not in other text or a tab.
  ["```\ncode\n```\t\nNext: x\n```\nNext: y", [5]],
  // Tildes open and close blocks too; only the same character closes one.
  ["~~~\nNext: x\n~~~\nNext: y", [3]],
  ["~~~markdown\n```bash\n~~~\nNext: x", [3]],
  ["```\n~~~\nNext: x\n```\nNext: y", [4]],
  ["````\n~~~~\nNext: x\n```\nNext: y\n````\nNext: z", [6]],
  // A block opened after a list marker ends with its list item: at a line
  // left of the item's text after a blank line, or at a new item.
  ["Пусни:\n- ```bash\n  npm test\n\nСледва: x", [4]],
  ["1. ```bash\n   npm i\n   ```\n2. ```bash\n   npm test\n\nСледва: x", [6]],
  ["- ```bash\n  npm test\n- **Следва:** x", [2]],
  ["- ```bash\n  a\n\n  b\n  ```\nNext: x", [5]],
  // A closing fence left of the list item's text closes the block, as the
  // model meant it to; marked would start a new block there instead.
  ["- ```bash\n  npm test\n```\n\nNext: x", [4]],
  // A block's fences are measured from where the text of its list item starts
  // (column 0 outside lists), and only a closing fence at most three columns
  // past it closes the block: the nested blocks of a README, a docs page or a
  // heredoc written in an item are code. A fence two columns under "1. " is
  // outside the list, as is one two columns in at the top, so their closing
  // fences are at most three columns in.
  [
    [
      "Готово. Ето стъпките:",
      "",
      "1. Създай `README.md`:",
      "",
      "    ```markdown",
      "    # Synchron",
      "",
      "    ## Инсталиране",
      "",
      "    1. Инсталирай зависимостите:",
      "       ```bash",
      "       npm install",
      "       ```",
      "    2. Пусни сървъра:",
      "       ```bash",
      "       npm start",
      "       ```",
      "    ```",
      "",
      "2. Качи промяната в GitHub.",
      "",
      "Следва: Пусни `npm test` и ми кажи резултата.",
    ].join("\n"),
    [21],
  ],
  [
    [
      "Here is the change:",
      "",
      "- Update `README.md`:",
      "    ```markdown",
      "    ## Quick start",
      "    - Install:",
      "      ```bash",
      "      npm install",
      "      ```",
      "    - Run:",
      "      ```bash",
      "      npm start",
      "      ```",
      "    ```",
      "",
      "Next: Run `npm test` and tell me the result.",
    ].join("\n"),
    [15],
  ],
  [
    [
      "- Добави `docs/setup.md`:",
      "   ```md",
      "   1. Клонирай хранилището:",
      "      ```bash",
      "      git clone https://example.com/app.git",
      "      ```",
      "   2. Инсталирай:",
      "      ```bash",
      "      npm ci",
      "      ```",
      "   ```",
      "",
      "**Следва:** Отвори `docs/setup.md` в GitHub и провери как изглежда.",
    ].join("\n"),
    [12],
  ],
  [
    [
      "- Add `scripts/init.sh`:",
      "    ```bash",
      "    if [ ! -f README.md ]; then",
      "      cat > README.md <<'EOF'",
      "      ```bash",
      "      npm start",
      "      ```",
      "    EOF",
      "    fi",
      "    ```",
      "",
      "Next: Run `bash scripts/init.sh` and tell me what it prints.",
    ].join("\n"),
    [11],
  ],
  [
    [
      "1. Create `README.md`:",
      "  ```markdown",
      "  ## Setup",
      "  - Install:",
      "    ```bash",
      "    npm install",
      "    ```",
      "  ```",
      "",
      "Next: Run `npm test` and tell me the result.",
    ].join("\n"),
    [9],
  ],
  [
    [
      "README:",
      "",
      "  ```markdown",
      "  ## Usage",
      "  - Run:",
      "    ```bash",
      "    npm start",
      "    ```",
      "  ```",
      "",
      "Следва: Пусни `npm start`.",
    ].join("\n"),
    [10],
  ],
  // A block on its own line in a list item ends with the item too: a fence
  // line that only closes a nested block leaves a new block open, and the
  // line after the blank line ends it with the item. So does an unindented
  // heredoc line after a blank line, and the closing fence then opens a block.
  ["1. Create:\n   ```bash\n   cat > a <<EOF\n\nhello\nEOF\n   ```\n\nNext: Run the tests and tell me the result.", []],
  [
    [
      "1. Създай `prompt.py`:",
      "   ```python",
      '   PROMPT = """',
      "   Върни резултата като JSON:",
      "   ```json",
      '   {"ok": true}',
      "   ```",
      '   """',
      "   ```",
      "",
      "Следва: Пусни `python prompt.py` и ми кажи какво връща.",
    ].join("\n"),
    [10],
  ],
  [
    [
      "- Create the README:",
      "  ```bash",
      "  cat > README.md <<'EOF'",
      "  # App",
      "  ```bash",
      "  npm start",
      "  ```",
      "  EOF",
      "  ```",
      "",
      "Next: Run the script and tell me what it prints.",
    ].join("\n"),
    [10],
  ],
  [
    [
      "1. Създай `docs/usage.md`:",
      "   ~~~markdown",
      "   Пример:",
      "   ~~~bash",
      "   npm start",
      "   ~~~",
      "   ~~~",
      "",
      "Следва: Отвори `docs/usage.md` в GitHub.",
    ].join("\n"),
    [8],
  ],
  // A line left of the item's text that starts with a fence ends the item and
  // its block, and so does one right below a bare fence line that opened a
  // block in the item, while that fence is fewer columns past the item's text
  // than the item's text is past its parent's.
  ["- ```bash\n  npm test\n```diff\n- a\n+ b\n```\nNext: x", [6]],
  ["1. Пусни:\n   ```bash\n   npm test\n   ```\n   ```\nСледва: x", [5]],
  ["- ```\nnpm test\nNext: x", [2]],
  ["- a\n  - b\n    ```\n  c\nNext: x", [4]],
  ["- a\n    ```\nb\nNext: x", []],
  // Lines right below a fence with an info string stay in its block, as the
  // model meant them, so its closing fence still closes it; marked's other
  // item endings, such as a heading, are not read.
  ["1. ```bash\nnpm test\n```\n\nNext: x", [4]],
  ["- ```bash\nnpm test\nNext: x", []],
  ["- ```bash\n  npm test\n# done\nNext: x", []],
  // When that line is left of the item's text, the block stays open at the
  // endings of its item while a line further down would close it. It ends at
  // the next such line, normally its own closing fence (or a later block's
  // fence line when its own is missing), also after a blank line and an
  // unindented line, or with its item when none follows.
  [
    [
      "1. Инсталирай Express:",
      "   ```bash",
      "npm install express",
      "   ```",
      "2. Създай `server.js`:",
      "   ```js",
      'const express = require("express");',
      "",
      "const app = express();",
      'app.get("/", (req, res) => res.send("Здравей!"));',
      "app.listen(3000);",
      "   ```",
      "",
      "Следва: Пусни `node server.js` и ми кажи какво пише.",
    ].join("\n"),
    [13],
  ],
  [
    [
      "1. Install:",
      "   ```bash",
      "   npm install",
      "```",
      "1. Създай `app.py`:",
      "   ```python",
      "def f():",
      "    return 1",
      "",
      "def g():",
      "    return 2",
      "   ```",
      "",
      "Следва: Пусни тестовете и ми кажи резултата.",
    ].join("\n"),
    [13],
  ],
  ["- ```bash\nnpm test\n- b\nNext: x", [3]],
  [
    "1. Install:\n   ```bash\nnpm install express\n2. Create `.env`:\n   ```\n   PORT=3000\n   ```\n\nСледва: Пусни `npm start` и ми кажи какво пише.",
    [8],
  ],
  // After such a block, a bare fence that could not be a closing fence
  // outside a list, right after its item's marker or on a line of its own
  // four or more columns in, is read the same way when the line below it is
  // left of the item's text. With no such block before it, or on a line of
  // its own fewer columns in, the fence's item ends at that line.
  ["1. ```diff\n- old\n+ new\n```\n2. ```\nconst page = {};\n```\n\nСледва: Пусни тестовете.", [8]],
  [
    "1. ```diff\n- old\n+ new\n```\n2. ```\nconst page = {\n  Next: 'kept',\n};\n```\n3. Провери:\n\nNext: Run `npm test` and tell me the result.",
    [11],
  ],
  ["- ```\nnpm test\n```\nNext: x", []],
  ["1. ```js\na\n```\n2. Step:\n   ```\nb\n   ```\nNext: x", []],
  // So in a list whose text starts four columns in ("1.  ", "*   ", or "1. "
  // with its code four columns in) and whose code and closing fences are at
  // column 0, a later step's bare fence on its own line keeps its code.
  [
    [
      "1.  Създай `app.py`:",
      "    ```python",
      "import os",
      "",
      'print(os.environ["PORT"])',
      "```",
      "2.  Създай `.env`:",
      "    ```",
      "PORT=8080",
      "```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [11],
  ],
  [
    [
      "1.  Обнови `app.js`:",
      "    ```diff",
      "- const port = 3000;",
      "+ const port = process.env.PORT || 3000;",
      "```",
      "2.  Създай `.env`:",
      "    ```",
      "PORT=8080",
      "```",
      "",
      "Следва: Рестартирай сървъра и ми кажи дали работи.",
    ].join("\n"),
    [10],
  ],
  [
    [
      "*   Create `server.js`:",
      "    ```js",
      'const express = require("express");',
      "",
      "express().listen(3000);",
      "```",
      "*   Run it. You should see:",
      "    ```",
      "Listening on 3000",
      "```",
      "",
      "**Next:** Open http://localhost:3000 and tell me what you see.",
    ].join("\n"),
    [11],
  ],
  [
    [
      "1. Добави workflow:",
      "    ```yaml",
      "- name: Install",
      "  run: npm ci",
      "```",
      "2. Добави тайната в `.env`:",
      "    ```",
      "API_KEY=...",
      "```",
      "",
      "Следва: Пусни workflow-а и ми кажи резултата.",
    ].join("\n"),
    [10],
  ],
  // The same with a language on that fence, with the code aligned, with no
  // blank line in the first step, and with the fence right after its marker.
  [
    [
      "1.  Създай `app.py`:",
      "    ```python",
      "import os",
      "",
      'print(os.environ["PORT"])',
      "```",
      "2.  Създай `.env`:",
      "    ```env",
      "PORT=8080",
      "```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [11],
  ],
  [
    [
      "1.  Създай `app.py`:",
      "    ```python",
      "    import os",
      "",
      '    print(os.environ["PORT"])',
      "    ```",
      "2.  Създай `.env`:",
      "    ```",
      "    PORT=8080",
      "    ```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [11],
  ],
  [
    [
      "1.  Инсталирай:",
      "    ```bash",
      "pip install flask",
      "```",
      "2.  Създай `.env`:",
      "    ```",
      "PORT=8080",
      "```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [9],
  ],
  [
    [
      "1.  ```python",
      "import os",
      "",
      'print(os.environ["PORT"])',
      "```",
      "2.  ```",
      "PORT=8080",
      "```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [9],
  ],
  // With the list's text three columns in, that fence could close a block
  // outside a list: its item ends at the code below it, and the closing
  // fence after the code opens a block, as marked reads it.
  [
    [
      "1. Създай `app.py`:",
      "   ```python",
      "import os",
      "",
      'print(os.environ["PORT"])',
      "```",
      "2. Създай `.env`:",
      "   ```",
      "PORT=8080",
      "```",
      "",
      "Следва: Пусни `python app.py` и ми кажи какво пише.",
    ].join("\n"),
    [],
  ],
  // A closing line further down that is too far in, too short, or of the other
  // character does not keep such a block open.
  ["- ```bash\nnpm test\n- b\n      ```\nNext: x", [4]],
  ["- ````bash\nnpm test\n- b\n```\n```\nNext: x", [5]],
  ["- ~~~bash\nnpm test\n- b\n```\n```\nNext: x", [5]],
  // The rule reads these otherwise than marked: a block whose first line is
  // at the item's text ends with its item at a blank line and an unindented
  // line, also after such a step; a fence nested in a block whose code is
  // unindented closes that block, so the block's own closing fence opens one;
  // an HTML block is not read, so the closing fence after it opens a block;
  // an item does not end below a line four or more columns past its text;
  // and after a step whose code is unindented, the later steps' fences pair
  // as the model wrote them.
  [HEREDOC_AFTER_UNINDENTED_STEP, []],
  [HEREDOC_AFTER_UNINDENTED_BLANK_STEP, []],
  [FENCE_IN_UNINDENTED_PYTHON, []],
  [FENCE_IN_UNINDENTED_PYTHON_AT_ITEM, [9]],
  [BARE_FENCE_HTML, []],
  [OVER_INDENTED_CLOSER, []],
  [FOUR_COLUMN_THREE_STEPS, [15]],
];
// Where the rule knowingly reads an answer otherwise than marked, with
// marked's Next lines: the model's closing fence closes its block, and lines
// below a fence with an info string stay code, where marked ends the list
// item (a block left open then swallows a later Next line); marked's other
// item endings are not read.
const KNOWN_DIFFERENCES = new Map([
  ["- ```bash\n  npm test\n```\n\nNext: x", []],
  ["1. ```bash\nnpm test\n```\n\nNext: x", []],
  ["- ```bash\nnpm test\nNext: x", [2]],
  ["- ```bash\n  npm test\n# done\nNext: x", [3]],
  // marked ends step 1 at its unindented code and pairs every later fence one off.
  [HEREDOC_AFTER_UNINDENTED_STEP, [13]],
  [HEREDOC_AFTER_UNINDENTED_BLANK_STEP, [16]],
  [FOUR_COLUMN_THREE_STEPS, []],
  // marked ends the step at its unindented code: the JSON fences pair with each
  // other, and the step's closing fence is text, or, at most three columns in,
  // opens a block that runs to the end of the answer.
  [FENCE_IN_UNINDENTED_PYTHON, [9]],
  [FENCE_IN_UNINDENTED_PYTHON_AT_ITEM, []],
  // marked's HTML block runs to the blank line and takes the closing fence with it.
  [BARE_FENCE_HTML, [7]],
  // marked ends the item below a line four or more columns past the item's text.
  [OVER_INDENTED_CLOSER, [4]],
]);

test("the server and the page find the same Next lines outside the same code blocks", async () => {
  const { codeBlocksOfLines, nextStepLineIndexes } = await import("../src/services/projectConversationContextService.js");
  const { answerNextLineIndex, nextLineCodeBlocks } = nextStepFunctions();
  // The page gives the last Next line of the whole answer. Every one is a line
  // it takes for a Next line on its own that its code blocks leave outside
  // code (a block may look further down, so a shorter answer can differ).
  const pageIndexes = (lines) => {
    const blocks = nextLineCodeBlocks(lines);
    return lines.flatMap((line, index) => (!blocks[index] && answerNextLineIndex([line]) === 0 ? [index] : []));
  };
  for (const [text, expected] of FENCE_CASES) {
    const lines = text.split("\n");
    assert.deepEqual(nextStepLineIndexes(lines), expected, text);
    assert.equal(answerNextLineIndex(lines), expected.at(-1) ?? -1, text);
    assert.deepEqual(pageIndexes(lines), expected, text);
    assert.deepEqual(nextLineCodeBlocks(lines), codeBlocksOfLines(lines), text);
  }
  // And every answer of up to four lines made of these agrees too, in every
  // line's code block.
  const vocabulary = [
    "```js",
    "```",
    "````",
    "~~~",
    "- ```bash",
    "- ```",
    "  ```",
    "   ```bash",
    "    ```",
    "``` js",
    "```npm test```",
    "Next: x",
    "**Следва:** y",
    "- text",
    "1. text",
    "text",
    "",
  ];
  let answers = [[]];
  for (let length = 1; length <= 4; length += 1) {
    answers = answers.flatMap((lines) => vocabulary.map((line) => [...lines, line]));
    for (const lines of answers) {
      const indexes = nextStepLineIndexes(lines);
      assert.deepEqual(pageIndexes(lines), indexes, lines.join("\n"));
      assert.equal(answerNextLineIndex(lines), indexes.at(-1) ?? -1, lines.join("\n"));
      assert.deepEqual(nextLineCodeBlocks(lines), codeBlocksOfLines(lines), lines.join("\n"));
    }
  }
});

test("blocks with unindented code take about as long as plain lines, however many closing lines too far in are below them", async () => {
  const { codeBlocksOfLines } = await import("../src/services/projectConversationContextService.js");
  const { nextLineCodeBlocks } = nextStepFunctions();
  // Closing lines too far in to close any of the blocks above them, each left
  // of every line of its run below it, so the look-up keeps every one: runs
  // of 3 to 42 backticks, 8 to 47 columns in. The same answer with plain
  // lines of the same length in their place is the measure.
  const closers = [];
  for (let run = 3; run < 43; run += 1) {
    for (let column = 8; column < 48; column += 1) closers.push(`${" ".repeat(column)}${"`".repeat(run)}`);
  }
  const plain = closers.map((line) => "x".repeat(line.length));
  // 15,000 blocks whose code is unindented, after a first such block: below
  // a fence with a language, or a bare fence right after its marker, each
  // ended by the next item with nothing to close it; or below a bare fence on
  // its own line four columns in, each closed at column 0.
  for (const unit of ["- ```x\na\n", "2. ```\nb\n", "1.  b\n    ```\nc\n```\n"]) {
    const blocks = `- \`\`\`x\na\n${unit.repeat(15_000)}`;
    const answer = (below) => `${blocks}${below.join("\n")}\n\nNext: Run it.`.split("\n");
    for (const scan of [codeBlocksOfLines, nextLineCodeBlocks]) {
      // The fastest of five runs, so a busy machine does not fail the check.
      const fastest = (lines) => {
        let best = Infinity;
        for (let run = 0; run < 5; run += 1) {
          const start = performance.now();
          assert.equal(scan(lines).at(-1), null);
          best = Math.min(best, performance.now() - start);
        }
        return best;
      };
      const times = fastest(answer(closers)) / fastest(answer(plain));
      assert.ok(times < 2.5, `${scan.name}, ${JSON.stringify(unit)}: ${times.toFixed(2)} times as long`);
    }
  }
});

// marked, which shows the answer on the page, as the page loads it.
const markedModule = { exports: {} };
new Function("module", "exports", await readFile(new URL("../public/vendor/marked-18.0.7/marked.umd.js", import.meta.url), "utf8"))(
  markedModule,
  markedModule.exports,
);
const { marked } = markedModule.exports;

test("the Next lines outside code are the ones marked shows outside code", () => {
  const { answerNextLineIndex } = nextStepFunctions();
  // Each Next line gets a probe word; it is code if the word lands in a <pre>.
  const markedNextLines = (lines) =>
    lines.flatMap((line, index) => {
      if (answerNextLineIndex([line]) !== 0) return [];
      const probe = lines.map((text, at) => (at === index ? text.replace(":", ": PROBEWORD ") : text));
      const blocks = marked.parse(probe.join("\n")).match(/<pre[\s\S]*?<\/pre>/gu) || [];
      return blocks.some((block) => block.includes("PROBEWORD")) ? [] : [index];
    });
  for (const [text, expected] of FENCE_CASES) {
    const shown = KNOWN_DIFFERENCES.has(text) ? KNOWN_DIFFERENCES.get(text) : expected;
    assert.deepEqual(markedNextLines(text.split("\n")), shown, text);
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

test("an allow link only in code does not count as shown, so the clickable allow line is added", async () => {
  const { withGoogleAllowLinks } = await import("../src/routes/chat.js");
  const { GoogleDriveError } = await import("../src/services/googleDriveService.js");
  const url = "https://cloudaicore.com/api/google/connect?add=youtube";
  const notAllowed = {
    status: "rejected",
    request: { capability: "youtube.channel" },
    error: new GoogleDriveError(`YouTube още не е разрешен. [Свържи YouTube](${url}).`, 403, "GOOGLE_SCOPE_REQUIRED"),
  };
  const linksOutsideCode = (text) => marked.parse(text).replace(/<pre[\s\S]*?<\/pre>/gu, "").includes(`href="${url}"`);
  // The Next line is code in the list item's open block, as marked shows it.
  const answer = `- \`\`\`bash\n  npm test\nNext: [Allow YouTube](${url}), then ask me again.`;
  assert.equal(linksOutsideCode(answer), false);
  const reply = withGoogleAllowLinks(answer, [notAllowed], "en");
  assert.equal(reply, `${answer}\n\nYouTube is not allowed yet. [Allow YouTube](${url})`);
  assert.equal(linksOutsideCode(reply), true);
  // A link on a line outside code is shown, and nothing is added.
  const shown = `You can allow it here: [Allow YouTube](${url}).\n\n- \`\`\`bash\n  npm test\n  \`\`\``;
  assert.equal(withGoogleAllowLinks(shown, [notAllowed], "en"), shown);
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
