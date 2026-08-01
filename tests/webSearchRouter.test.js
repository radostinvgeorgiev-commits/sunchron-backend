import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSearchResult,
  isWebSearchRequest,
  searchWeb,
  WebSearchError,
} from "../src/services/webSearchService.js";

test("extractSearchResult returns text and unique clickable sources", () => {
  const result = extractSearchResult({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Проверен отговор.",
            annotations: [
              {
                type: "url_citation",
                title: "Източник",
                url: "https://example.com/a",
              },
              {
                type: "url_citation",
                title: "Повторение",
                url: "https://example.com/a",
              },
              {
                type: "url_citation",
                title: "Втори",
                url: "https://example.com/b",
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.text, "Проверен отговор.");
  assert.deepEqual(result.sources, [
    { title: "Източник", url: "https://example.com/a" },
    { title: "Втори", url: "https://example.com/b" },
  ]);
});

test("extractSearchResult handles an empty response", () => {
  assert.deepEqual(extractSearchResult({ output: [] }), {
    text: "",
    sources: [],
  });
});

test("extractSearchResult supports current nested url citations", () => {
  const result = extractSearchResult({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Актуален отговор.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  title: "Проверен източник",
                  url: "https://example.com/current",
                },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.sources, [
    {
      title: "Проверен източник",
      url: "https://example.com/current",
    },
  ]);
});

test("recognizes explicit and time-sensitive web searches", () => {
  assert.equal(isWebSearchRequest("Потърси това в интернет."), true);
  assert.equal(isWebSearchRequest("Провери актуалното време във Варна."), true);
  assert.equal(isWebSearchRequest("Потърси актуалната прогноза."), true);
  assert.equal(isWebSearchRequest("Провери файловете ми в Drive."), false);
});

test("web search fails clearly when the protected OpenAI key is missing", async () => {
  await assert.rejects(
    () => searchWeb("актуално време", { apiKey: "" }),
    (error) =>
      error instanceof WebSearchError &&
      error.code === "OPENAI_NOT_CONFIGURED" &&
      error.status === 503,
  );
});
