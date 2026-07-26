import assert from "node:assert/strict";
import test from "node:test";

import { conversationTitleFromMessages } from "../src/services/memoryService.js";

test("conversation title uses the first user message", () => {
  assert.equal(
    conversationTitleFromMessages([
      { role: "assistant", content: "Здравей" },
      { role: "user", content: "  Какво знаеш   за проекта? " },
      { role: "user", content: "Втори въпрос" },
    ]),
    "Какво знаеш за проекта?",
  );
});

test("conversation title is shortened safely", () => {
  const title = conversationTitleFromMessages([
    { role: "user", content: "а".repeat(80) },
  ]);
  assert.equal(title.length, 50);
  assert.match(title, /…$/u);
});

test("conversation title has a useful fallback", () => {
  assert.equal(
    conversationTitleFromMessages([{ role: "assistant", content: "Отговор" }]),
    "Нов разговор",
  );
});
