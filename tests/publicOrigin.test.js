import assert from "node:assert/strict";
import test from "node:test";
import { googleConnectUrl, publicOrigin, startOnPublicOrigin } from "../src/config/publicOrigin.js";

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

test("the connector's Allow links follow the Google return address too", async () => {
  const { createMcpCapabilityHandler } = await import("../src/services/mcpCapabilityService.js");
  const saved = Object.fromEntries(
    ["GOOGLE_REDIRECT_URI", "GOOGLE_CONNECT_URL", "PUBLIC_ORIGIN"].map((key) => [key, process.env[key]]),
  );
  const handler = (googleSession) =>
    createMcpCapabilityHandler({
      audit: async () => {},
      resolveLatestGoogleSession: async () => googleSession,
      dependencies: { fileSaveSessionFor: async () => null, publishSessionFor: async () => null },
    });
  try {
    delete process.env.GOOGLE_CONNECT_URL;
    delete process.env.PUBLIC_ORIGIN;
    for (const origin of ["https://cloudaicore.com", "https://novariumai.com"]) {
      process.env.GOOGLE_REDIRECT_URI = `${origin}/api/google/callback`;
      await assert.rejects(
        () => handler(null)("list_google_drive_files", {}, { ownerId: "owner" }),
        (error) => error.message.includes(`Отвори ${origin}/api/google/connect.`),
      );
      await assert.rejects(
        () => handler("main")("generate_video", { prompt: "реклама" }, { ownerId: "owner" }),
        (error) => error.message.includes(`${origin}/api/google/connect?add=save`),
      );
      await assert.rejects(
        () => handler("main")("publish_video_to_youtube", { driveFileId: "file1" }, { ownerId: "owner" }),
        (error) => error.message.includes(`${origin}/api/google/connect?add=publish`),
      );
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a sign-in or connection starts on the address Google and GitHub return to", () => {
  const run = (env, { method = "GET", host, url }) => {
    const path = url.replace(/\?.*$/u, "");
    let redirect = null;
    let passed = false;
    startOnPublicOrigin(env)(
      { method, path, originalUrl: url, get: (name) => (name.toLowerCase() === "host" ? host : undefined) },
      { redirect: (status, to) => (redirect = [status, to]) },
      () => (passed = true),
    );
    return redirect || (passed ? "next" : "nothing");
  };
  const old = { GOOGLE_REDIRECT_URI: "https://cloudaicore.com/api/google/callback" };
  const moved = { GOOGLE_REDIRECT_URI: "https://novariumai.com/api/google/callback" };
  // Today Google returns to the old name: a sign-in begun on novariumai.com
  // first moves there, so its state cookie is where Google comes back.
  assert.deepEqual(run(old, { host: "novariumai.com", url: "/api/auth/google/start" }), [
    302,
    "https://cloudaicore.com/api/auth/google/start",
  ]);
  assert.equal(run(old, { host: "cloudaicore.com", url: "/api/auth/google/start" }), "next");
  // After the move, the old name sends every start to novariumai.com.
  for (const url of [
    "/api/auth/google/start",
    "/api/auth/github/start",
    "/api/auth/facebook/start",
    "/api/google/connect?add=gmail",
    "/api/github/connect",
  ]) {
    assert.deepEqual(run(moved, { host: "cloudaicore.com", url }), [302, `https://novariumai.com${url}`], url);
    assert.deepEqual(run(moved, { host: "www.cloudaicore.com", url }), [302, `https://novariumai.com${url}`], url);
    assert.equal(run(moved, { host: "novariumai.com", url }), "next", url);
  }
  // Only the start addresses, only GET, only the site's own names.
  assert.equal(run(moved, { host: "cloudaicore.com", url: "/api/google/callback?code=x" }), "next");
  assert.equal(run(moved, { host: "cloudaicore.com", url: "/mcp" }), "next");
  assert.equal(run(moved, { method: "POST", host: "cloudaicore.com", url: "/api/auth/google/start" }), "next");
  assert.equal(run(moved, { host: "127.0.0.1:8080", url: "/api/google/connect" }), "next");
  assert.equal(run({}, { host: "localhost:3000", url: "/api/auth/google/start" }), "next");
});
