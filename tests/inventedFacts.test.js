import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  combineConversationHistory,
  effectiveConversationHistory,
  normalizeRecentConversationHistory,
} from "../src/routes/chat.js";
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

test("a fence in a list item, or closed by a longer run, is read as the page shows it", () => {
  // The list item's indented closing fence closes its block, so the answer's
  // own Next line after it is text and is stripped, now and in later history.
  const listed = "Пусни тестовете така:\n- ```bash\n  npm test\n  ```\n\nСледва: Провери задача ЛИПА-742.";
  const withoutNext = "Пусни тестовете така:\n- ```bash\n  npm test\n  ```";
  assert.equal(stripReplayedNextSteps(listed), withoutNext);
  for (const history of [
    effectiveConversationHistory([], [{ role: "assistant", content: listed }]),
    effectiveConversationHistory([{ role: "assistant", content: listed }], []),
  ]) {
    assert.deepEqual(history, [{ role: "assistant", content: withoutNext }]);
  }
  // A Next-looking line inside such a block is code and stays.
  const config = "Config:\n- ```yaml\n  Next: page-2\n  limit: 10\n  ```\nГотово.";
  assert.equal(stripReplayedNextSteps(config), config);
  assert.equal(stripReplayedNextSteps("1. ```bash\n   Следва: x\n   ```\n2) Готово."), "1. ```bash\n   Следва: x\n   ```\n2) Готово.");
  // A longer closing run closes the block; a shorter one inside a longer
  // block is code, and so is the Next-looking line after it.
  assert.equal(
    stripReplayedNextSteps("Ето кода:\n```js\nrun();\n````\nСледва: Пусни го и ми кажи ЛИПА-742."),
    "Ето кода:\n```js\nrun();\n````",
  );
  const nested = "Example:\n````md\n```\nNext: x\n```\n````\nDone.";
  assert.equal(stripReplayedNextSteps(nested), nested);
  assert.equal(stripReplayedNextSteps(`${nested}\nNext: Check it.`), nested);
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

// The history before the work was bounded: every raw entry stripped whole,
// then cut.
function historyStrippedWhole(persistent, recent, { rewrite = false } = {}) {
  const stripped = (messages) => (Array.isArray(messages) ? sanitizeAssistantHistory(messages) : []);
  const cleanRecent = normalizeRecentConversationHistory(stripped(recent));
  return rewrite ? cleanRecent : combineConversationHistory(stripped(persistent), cleanRecent);
}

// A seeded random source, so the same conversations are checked every run.
function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Questions and answers like real ones: text, lists and code blocks (also in
// list items and in "````" blocks) with Next-looking lines inside, Next lines
// of their own, answers that are only a Next line, and long code answers, a
// share of them between the given lengths.
function realisticConversation(random, { longShare = 0.2, long = [20_000, 90_000] } = {}) {
  const pick = (items) => items[Math.floor(random() * items.length)];
  const block = () => {
    const body = Array.from({ length: 2 + Math.floor(random() * 80) }, () =>
      pick(["Ето какво намерих в проекта.", "- точка от списъка", "  run();", "Next: page-2", "Следва: x", "", "next: y"]),
    );
    return pick([
      () => ["```js", ...body, "```"],
      () => ["- ```bash", ...body.map((line) => `  ${line}`), "  ```"],
      () => ["````md", "```", ...body, "```", "````"],
      () => body,
    ])().join("\n");
  };
  const answer = (length) => {
    if (random() < 0.1) return pick(["Следва: Провери ЛИПА-742.", "Next: Check LIPA-742."]);
    const parts = [];
    for (let size = 0; size < length; size += parts.at(-1).length) parts.push(block());
    if (random() < 0.7) parts.push(`${pick(["Следва:", "**Следва:**", "Next:", "- **Next step:**"])} провери ЛИПА-742.`);
    if (random() < 0.1) parts.push("[Allow YouTube](https://cloudaicore.com/api/google/connect?add=youtube)");
    return parts.join("\n\n");
  };
  const turns = [];
  for (let count = 2 + Math.floor(random() * 14); count > 0; count -= 1) {
    turns.push({ role: "user", content: random() < 0.05 ? "Въпрос. ".repeat(750) : "Покажи следващата част." });
    const length = random() < longShare ? long[0] + random() * (long[1] - long[0]) : 100 + random() * 4_000;
    turns.push({ role: "assistant", content: answer(length) });
  }
  return turns;
}

test("real conversations get the same history as when every entry was stripped whole", () => {
  const random = seededRandom(742);
  // Ordinary conversations, and code sessions whose answers are all long, so
  // they pass the room for long answers and the cut still has all it keeps.
  for (const [runs, options] of [[80], [10, { longShare: 1, long: [70_000, 99_000] }]]) {
    for (let run = 0; run < runs; run += 1) {
      const turns = realisticConversation(random, options);
      // The server reads the last 20 saved turns; the page sends its last 12,
      // sometimes with one it could not save, or none on a new page.
      const saved = turns.slice(-20);
      const unsaved = run % 3 ? [] : [{ role: "user", content: "Незаписана бележка." }];
      const recent = run % 5 === 0 ? [] : [...turns.slice(unsaved.length - 12), ...unsaved];
      for (const rewrite of [false, true]) {
        assert.deepEqual(
          effectiveConversationHistory(saved, recent, { rewrite }),
          historyStrippedWhole(saved, recent, { rewrite }),
          `run ${run}`,
        );
      }
    }
  }
  // More turns than the page sends, with answers that were only a Next line
  // among the newest: the cut still finds all the turns it keeps.
  const many = Array.from({ length: 40 }, (_, index) =>
    index % 2 ? { role: "assistant", content: `Отговор ${index}.\nСледва: x` } : { role: "user", content: `Въпрос ${index}.` },
  );
  for (const index of [33, 35, 37, 39]) many[index] = { role: "assistant", content: "Следва: Провери ЛИПА-742." };
  for (const [saved, recent, options] of [[many, many], [many, []], [[], many, { rewrite: true }]]) {
    assert.deepEqual(effectiveConversationHistory(saved, recent, options), historyStrippedWhole(saved, recent, options));
  }
});

test("a crafted 7.8 MB history is cut before its answers are split into lines", () => {
  // One answer of 3,900,000 line breaks, as a 7.8 MB request body; the same
  // with a letter at the end, so trimming alone does not empty it; and a
  // short answer padded with them, which keeps its text as the cut would.
  const body = JSON.stringify({ recentHistory: [{ role: "assistant", content: "\n".repeat(3_900_000) }] });
  assert.ok(body.length > 7_800_000);
  const { recentHistory } = JSON.parse(body);
  const lettered = [{ role: "assistant", content: `${"\n".repeat(3_900_000)}a` }];
  const padded = [{ role: "assistant", content: `Готово.\nСледва: x${"\n".repeat(3_900_000)}` }];
  for (const [history, expected] of [
    [recentHistory, []],
    [lettered, [{ role: "assistant", content: "a" }]],
    [padded, [{ role: "assistant", content: "Готово." }]],
  ]) {
    for (const options of [{}, { rewrite: true }]) {
      // The fastest of three runs, so a busy machine does not fail the check.
      let fastest = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        assert.deepEqual(effectiveConversationHistory([], history, options), expected);
        fastest = Math.min(fastest, performance.now() - start);
      }
      assert.ok(fastest < 50, `${fastest.toFixed(1)} ms`);
    }
  }
  // Spread over many answers, no more is read than the cut could use: four
  // long answers of 100,000 characters and 24,000 more, so the five newest.
  const spread = Array.from({ length: 16 }, () => ({ role: "assistant", content: `${"\n".repeat(240_000)}a` }));
  assert.deepEqual(effectiveConversationHistory([], spread), Array(5).fill({ role: "assistant", content: "a" }));
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
