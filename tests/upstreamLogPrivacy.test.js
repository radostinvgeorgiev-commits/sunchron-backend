import assert from "node:assert/strict";
import test from "node:test";

import { requestOpenAIText } from "../src/services/aiCoreService.js";
import { getRepositorySummary } from "../src/services/githubService.js";
import { createFile } from "../src/services/githubWriteService.js";
import { analyzeImage } from "../src/services/imageService.js";
import { searchWeb } from "../src/services/webSearchService.js";

const SENTINEL = "Bearer private-token personal@example.com private prompt";
const tinyPng = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mimeType: "image/png",
};

async function captureUpstreamFailure(run) {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(" "));
  try {
    await assert.rejects(run);
  } finally {
    console.error = originalConsoleError;
  }
  const output = logs.join("\n");
  assert.doesNotMatch(output, new RegExp(SENTINEL, "u"));
  assert.match(output, /503/u);
}

function failedResponse() {
  return new Response(SENTINEL, { status: 503 });
}

test("OpenAI chat failure logs status without the upstream response body", async () => {
  await captureUpstreamFailure(() =>
    requestOpenAIText({
      apiKey: "test-key",
      input: [{ role: "user", content: "test" }],
      fetchImpl: async () => failedResponse(),
    }),
  );
});

test("web search failure logs status without the upstream response body", async () => {
  await captureUpstreamFailure(() =>
    searchWeb("test", {
      apiKey: "test-key",
      fetchImpl: async () => failedResponse(),
    }),
  );
});

test("vision failure logs status without the upstream response body", async () => {
  await captureUpstreamFailure(() =>
    analyzeImage({
      image: tinyPng,
      prompt: "test",
      modelAccessKey: "test-key",
      fetchImpl: async () => failedResponse(),
    }),
  );
});

test("GitHub read failure logs status without the upstream response body", async () => {
  const originalFetch = global.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalApiUrl = process.env.GITHUB_API_URL;
  global.fetch = async () => failedResponse();
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  process.env.GITHUB_API_URL = "https://github.test";
  try {
    await captureUpstreamFailure(() => getRepositorySummary());
  } finally {
    global.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
  }
});

test("GitHub write failure logs status without the upstream response body", async () => {
  const originalFetch = global.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalApiUrl = process.env.GITHUB_API_URL;
  const originalToken = process.env.GITHUB_TOKEN;
  global.fetch = async () => failedResponse();
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.GITHUB_TOKEN = "test-token";
  try {
    await captureUpstreamFailure(() =>
      createFile({
        branch: "test-branch",
        path: "test.txt",
        content: "test",
        message: "test",
      }),
    );
  } finally {
    global.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
