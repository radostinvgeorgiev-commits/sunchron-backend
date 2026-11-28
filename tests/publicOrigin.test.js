import assert from "node:assert/strict";
import test from "node:test";
import { googleConnectUrl, publicOrigin } from "../src/config/publicOrigin.js";

test("sign-in and connect links stay on the address Google returns to", () => {
  const old = { GOOGLE_REDIRECT_URI: "https://cloudaicore.com/api/google/callback" };
  assert.equal(publicOrigin(old), "https://cloudaicore.com");
  assert.equal(googleConnectUrl(old), "https://cloudaicore.com/api/google/connect");
  const moved = { GOOGLE_REDIRECT_URI: "https://novariumai.com/api/google/callback" };
  assert.equal(publicOrigin(moved), "https://novariumai.com");
  assert.equal(googleConnectUrl(moved), "https://novariumai.com/api/google/connect");
});

test("without configuration the address is novariumai.com, and PUBLIC_ORIGIN wins", () => {
  assert.equal(publicOrigin({}), "https://novariumai.com");
  assert.equal(publicOrigin({ GOOGLE_REDIRECT_URI: "not a url" }), "https://novariumai.com");
  assert.equal(
    publicOrigin({ PUBLIC_ORIGIN: "https://example.test/", GOOGLE_REDIRECT_URI: "https://cloudaicore.com/x" }),
    "https://example.test",
  );
  assert.equal(googleConnectUrl({ GOOGLE_CONNECT_URL: "https://x.test/c" }), "https://x.test/c");
});
