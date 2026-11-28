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
