import assert from "node:assert/strict";
import test from "node:test";

import { isOverviewQuestion } from "../src/routes/chat.js";

test("recognizes Bulgarian personal overview questions with punctuation", () => {
  assert.equal(isOverviewQuestion("Какво знаеш за мен?", "мен"), true);
  assert.equal(isOverviewQuestion("Какво знаеш за мен", "мен"), true);
});

test("recognizes Bulgarian project overview questions with punctuation", () => {
  assert.equal(
    isOverviewQuestion("Какво знаеш за проекта?", "(?:проекта|synchron-x)"),
    true,
  );
  assert.equal(
    isOverviewQuestion(
      "Какво знаеш за Synchron-X?",
      "(?:проекта|synchron-x)",
    ),
    true,
  );
});

test("does not match longer unrelated words", () => {
  assert.equal(isOverviewQuestion("Какво знаеш за ментора?", "мен"), false);
});
