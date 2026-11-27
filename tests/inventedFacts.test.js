import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectiveConversationHistory } from "../src/routes/chat.js";
import {
  buildProjectConversationReference,
  sanitizeAssistantHistory,
  stripReplayedNextSteps,
} from "../src/services/projectConversationContextService.js";

test("a 'Следва:' line from an earlier AI reply is not replayed", () => {
  assert.equal(
    stripReplayedNextSteps("Здравей.\n\nСледва: Кажи какво да правим по ЛИПА-742."),
    "Здравей.",
  );
  assert.equal(stripReplayedNextSteps("**Следваща стъпка:** x\nТекст"), "Текст");
  // On English pages the line is "Next:".
  assert.equal(stripReplayedNextSteps("Hello.\n\nNext: Ask about LIPA-742."), "Hello.");
  assert.equal(stripReplayedNextSteps("- **Next step:** x\nText"), "Text");
  assert.equal(stripReplayedNextSteps("Text\n**Next Step:** x"), "Text");
  // The Bulgarian label counts in any case.
  assert.equal(stripReplayedNextSteps("Текст\nследва: x\nСЛЕДВАЩА СТЪПКА: y"), "Текст");
});

test("code and ordinary lines are never taken for a Next line", () => {
  const code = [
    "Use it like this:",
    "```ts",
    "function handle(",
    "  next: NextFunction,",
    ") {}",
    "const page = {",
    "  next: null,",
    "  Next: 'kept',",
    "};",
    "```",
  ].join("\n");
  assert.equal(stripReplayedNextSteps(`${code}\nNext: Add it to the router.`), code);
  // Outside code, a lowercase "next:" is text, and so are lines that only start
  // with the same word.
  const text = "Next week: the review.\nСледващата седмица: прегледът.\nnext: x";
  assert.equal(stripReplayedNextSteps(text), text);
});

test("a one-line ```code``` does not open a code block", () => {
  assert.equal(stripReplayedNextSteps("Пусни:\n```npm test```\nСледва: провери ЛИПА-742."), "Пусни:\n```npm test```");
  // Fences with an info string or indentation still open and close blocks.
  const code = "Run:\n  ```bash\nСледва: x\n  ```";
  assert.equal(stripReplayedNextSteps(`${code}\nNext: Check it.`), code);
});

test("a Next line is stripped from the whole answer, before the history cuts it", () => {
  const answer = "Ето файла:\n```js\n" + "x();\n".repeat(1500) + "```\nСледва: отвори ЛИПА-742.";
  // The answer without its Next line, cut to its last 6000 characters: the
  // cut starts inside the code block, so only its closing fence is left.
  const replayed = stripReplayedNextSteps(answer).slice(-6000);
  assert.doesNotMatch(replayed, /```js|Следва|ЛИПА-742/u);
  // The page's recent turns, the saved turns and a retry.
  for (const history of [
    effectiveConversationHistory([], [{ role: "assistant", content: answer }]),
    effectiveConversationHistory([{ role: "assistant", content: answer }], []),
    effectiveConversationHistory([], [{ role: "assistant", content: answer }], { rewrite: true }),
  ]) {
    assert.deepEqual(history, [{ role: "assistant", content: replayed }]);
  }
  // The total limit cuts the start off an older short answer the same way.
  const older = `Ето скрипта:\n\`\`\`js\n${"  step();\n".repeat(40)}\`\`\`\nСледва: пусни скрипта и ми прати ЛИПА-742.`;
  const newer = ["user", "assistant", "user", "assistant"].map((role) => ({ role, content: "а".repeat(5_900) }));
  assert.deepEqual(
    effectiveConversationHistory([], [{ role: "user", content: "Напиши скрипт." }, { role: "assistant", content: older }, ...newer]),
    [{ role: "assistant", content: stripReplayedNextSteps(older).slice(-400) }, ...newer],
  );
  // Code that looks like a Next line stays, also when the cut starts in its block.
  const config = "Ето конфигурацията:\n```yaml\n" + "- x\n".repeat(2000) + "Next: page-2\n```\nГотово.\nСледва: пусни я.";
  const [cut] = effectiveConversationHistory([], [{ role: "assistant", content: config }]);
  assert.match(cut.content, /\n- x\nNext: page-2\n```\nГотово\.$/u);
});

test("the saved turns and the page's recent ones still overlap once their Next lines are stripped", () => {
  const answer = "Ето файла:\n```js\n" + "x();\n".repeat(1500) + "```\nСледва: отвори ЛИПА-742.";
  const saved = [
    { role: "user", content: "Дай ми файла." },
    { role: "assistant", content: answer },
    { role: "user", content: "Покажи канала ми." },
    { role: "assistant", content: "Каналът има 12 видеа.\n\nСледва: Провери ЛИПА-742." },
    { role: "user", content: "Добре." },
    { role: "assistant", content: "Следва: Разреши YouTube." },
  ];
  // The page sends its last turns, as they were stored, and one it could not
  // save. Matched, the saved turn before them stays and none is repeated.
  const recent = [...saved.slice(1), { role: "user", content: "Незаписана бележка." }];
  assert.deepEqual(effectiveConversationHistory(saved, recent), [
    { role: "user", content: "Дай ми файла." },
    { role: "assistant", content: stripReplayedNextSteps(answer).slice(-6000) },
    { role: "user", content: "Покажи канала ми." },
    { role: "assistant", content: "Каналът има 12 видеа." },
    { role: "user", content: "Добре." },
    { role: "user", content: "Незаписана бележка." },
  ]);
});

test("only assistant turns are cleaned and empty ones are dropped", () => {
  const cleaned = sanitizeAssistantHistory([
    { role: "user", content: "Следва: това го написах аз" },
    { role: "assistant", content: "Следва: ЛИПА-742" },
    { role: "assistant", content: "Отговор\nСледва: X" },
  ]);
  assert.deepEqual(cleaned, [
    { role: "user", content: "Следва: това го написах аз" },
    { role: "assistant", content: "Отговор" },
  ]);
});

test("project reference for other models drops replayed next steps", () => {
  const reference = buildProjectConversationReference({
    name: "P",
    objective: "",
    decisions: [],
    conversations: [[{ role: "assistant", content: "Здравей.\nСледва: проектния код ЛИПА-742" }]],
  });
  assert.doesNotMatch(reference, /ЛИПА-742/u);
});

test("every model is told earlier AI replies are unverified", () => {
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  const council = readFileSync(new URL("../src/services/aiCouncilService.js", import.meta.url), "utf8");
  assert.equal((chat.match(/Предишните отговори на AI в историята и в справките са непроверени/gu) || []).length, 2);
  assert.match(council, /Предишните AI отговори в контекста са непроверени/u);
  assert.match(council, /При поздрав или общ въпрос отговори естествено/u);
});
