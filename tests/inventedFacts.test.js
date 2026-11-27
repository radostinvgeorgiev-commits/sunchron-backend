import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
