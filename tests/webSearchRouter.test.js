import test from "node:test";
import assert from "node:assert/strict";
import { extractSearchResult } from "../src/routes/webSearchRouter.js";

test("extractSearchResult returns text and unique clickable sources", () => {
  const result = extractSearchResult({
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: "Проверен отговор.",
        annotations: [
          { type: "url_citation", title: "Източник", url: "https://example.com/a" },
          { type: "url_citation", title: "Повторение", url: "https://example.com/a" },
          { type: "url_citation", title: "Втори", url: "https://example.com/b" },
        ],
      }],
    }],
  });

  assert.equal(result.text, "Проверен отговор.");
  assert.deepEqual(result.sources, [
    { title: "Източник", url: "https://example.com/a" },
    { title: "Втори", url: "https://example.com/b" },
  ]);
});

test("extractSearchResult handles an empty response", () => {
  assert.deepEqual(extractSearchResult({ output: [] }), { text: "", sources: [] });
});
