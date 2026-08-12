import assert from "node:assert/strict";
import test from "node:test";

import {
  getPublicClientConfig,
  resolvePublicHttpsUrl,
} from "../src/routes/publicConfigRouter.js";

test("public client config uses safe HTTPS values", () => {
  assert.deepEqual(
    getPublicClientConfig({
      CHATGPT_WORK_URL: "https://chatgpt.com/g/g-example",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/g/g-example",
    },
  );
});

test("public client config falls back without exposing unsafe URLs", () => {
  assert.deepEqual(
    getPublicClientConfig({
      CHATGPT_WORK_URL: "javascript:alert(1)",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/",
    },
  );
  assert.equal(
    resolvePublicHttpsUrl("https://example.com/path", "https://fallback.test/"),
    "https://example.com/path",
  );
});
