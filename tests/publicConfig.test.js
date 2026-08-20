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
      GOOGLE_CLOUD_CONSOLE_URL: "https://console.cloud.google.com/run?project=example",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/g/g-example",
      googleCloudConsoleUrl: "https://console.cloud.google.com/run?project=example",
    },
  );
});

test("public client config falls back without exposing unsafe URLs", () => {
  assert.deepEqual(
    getPublicClientConfig({
      CHATGPT_WORK_URL: "javascript:alert(1)",
      GOOGLE_CLOUD_CONSOLE_URL: "http://insecure.example",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/",
      googleCloudConsoleUrl: "https://console.cloud.google.com/run",
    },
  );
  assert.equal(
    resolvePublicHttpsUrl("https://example.com/path", "https://fallback.test/"),
    "https://example.com/path",
  );
});
