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
      DIGITALOCEAN_DASHBOARD_URL: "https://cloud.digitalocean.com/apps",
      CLOUDFLARE_DASHBOARD_URL: "https://dash.cloudflare.com/",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/g/g-example",
      digitalOceanUrl: "https://cloud.digitalocean.com/apps",
      cloudflareUrl: "https://dash.cloudflare.com/",
    },
  );
});

test("public client config falls back without exposing unsafe URLs", () => {
  assert.deepEqual(
    getPublicClientConfig({
      CHATGPT_WORK_URL: "javascript:alert(1)",
      DIGITALOCEAN_DASHBOARD_URL: "http://insecure.example",
      CLOUDFLARE_DASHBOARD_URL: "not a url",
    }),
    {
      chatgptWorkUrl: "https://chatgpt.com/",
      digitalOceanUrl: "https://cloud.digitalocean.com/",
      cloudflareUrl: "https://dash.cloudflare.com/",
    },
  );
  assert.equal(
    resolvePublicHttpsUrl("https://example.com/path", "https://fallback.test/"),
    "https://example.com/path",
  );
});
