import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cleanVideoPrompt,
  createVideoGenerationService,
  pickAspectRatio,
} from "../src/services/videoGenerationService.js";

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const videoStep = (part) => ({ steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", ...part }] }], status: "completed" });

test("a video is made from the description, charged first, returned as MP4 bytes", async () => {
  const order = [];
  let sent;
  const service = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve: async (provider, model) => {
      order.push(`reserve ${provider} ${model}`);
      return async () => order.push("refund");
    },
    fetchImpl: async (url, options) => {
      order.push(`post ${url}`);
      sent = JSON.parse(options.body);
      assert.equal(options.headers["x-goog-api-key"], "k");
      return ok(videoStep({ data: Buffer.from("MP4").toString("base64") }));
    },
  });
  const result = await service.generate("  реклама за кафене\nза телефон ");
  assert.deepEqual(order, [
    "reserve gemini gemini-omni-1.1-flash",
    "post https://generativelanguage.googleapis.com/v1beta/interactions",
  ]);
  assert.equal(sent.input, "реклама за кафене за телефон");
  assert.deepEqual(sent.response_format, { type: "video", aspect_ratio: "9:16", resolution: "720p" });
  assert.equal(result.video.toString(), "MP4");
  assert.equal(result.mimeType, "video/mp4");
});

test("an unfinished answer is waited for and a file link is downloaded with the key", async () => {
  const calls = [];
  const service = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve: async () => async () => calls.push("refund"),
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push(url);
      if (url.endsWith("/interactions")) return ok({ id: "abc", status: "in_progress" });
      if (url.endsWith("/interactions/abc"))
        return ok(videoStep({ uri: "https://generativelanguage.googleapis.com/v1beta/files/f1" }));
      assert.equal(options.headers["x-goog-api-key"], "k");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("VID").buffer };
    },
  });
  const result = await service.generate("залез над морето");
  assert.equal(result.aspectRatio, "16:9");
  assert.equal(result.video.toString(), "VID");
  assert.equal(calls.at(-1), "https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media");
  assert.ok(!calls.includes("refund"));
});

test("failures and refusals give the units back; missing key and empty text are clear", async () => {
  let refunds = 0;
  const reserve = async () => async () => refunds++;
  const refusedService = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "blocked by safety policy" } }) }),
  });
  await assert.rejects(() => refusedService.generate("нещо"), { code: "VIDEO_REFUSED" });
  const brokenService = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await assert.rejects(() => brokenService.generate("нещо"), { code: "VIDEO_GENERATION_FAILED" });
  const foreignLink = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve,
    fetchImpl: async () => ok(videoStep({ uri: "https://evil.example/v.mp4" })),
  });
  await assert.rejects(() => foreignLink.generate("нещо"), { code: "VIDEO_GENERATION_FAILED" });
  assert.equal(refunds, 3);
  assert.throws(() => cleanVideoPrompt(" "), { code: "VIDEO_PROMPT_EMPTY" });
  await assert.rejects(() => createVideoGenerationService({ env: {} }).generate("котка"), { code: "VIDEO_NOT_CONFIGURED" });
});

test("phone formats are vertical, the rest horizontal, an explicit choice wins", () => {
  assert.equal(pickAspectRatio("клип за TikTok"), "9:16");
  assert.equal(pickAspectRatio("реклама за Instagram Reels"), "9:16");
  assert.equal(pickAspectRatio("реклама за сайта"), "16:9");
  assert.equal(pickAspectRatio("за телефон", "16:9"), "16:9");
});

test("videos are open to every account, go through the members' budget, and play from the page", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /"\/api\/videos",\s*requireOwnerSession,\s*paidAiRateLimiter,\s*createVideoGenerationRouter/u);
  assert.match(read("../server.js"), /media-src 'self' blob:/u);
  assert.match(read("../src/routes/videoGenerationRouter.js"), /router\.post\("\/", publicAiBudgetContext/u);
  assert.match(read("../src/services/publicAiBudget.js"), /PUBLIC_VIDEO_CREDITS = 100/u);
  assert.match(read("../public/ui-refresh.js"), /data-plus="video"/u);
  assert.match(read("../public/daily-plan.js"), /aicore:make-video/u);
});

test("videos are open to members (owner's decision 2026-11-27), and the owner switch still works", async () => {
  const { createVideoGenerationRouter, VIDEOS_FOR_MEMBERS } = await import("../src/routes/videoGenerationRouter.js");
  assert.equal(VIDEOS_FOR_MEMBERS, true);
  const express = (await import("express")).default;
  const made = [];
  const listen = (forMembers) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => ((req.owner = { role: req.get("x-role"), memoryOwnerId: "x" }), next()));
    app.use("/v", createVideoGenerationRouter({
      forMembers,
      service: { generate: async (prompt) => (made.push(prompt), { video: Buffer.from("MP4"), mimeType: "video/mp4", aspectRatio: "16:9" }) },
    }));
    return app.listen(0);
  };
  const open = listen(VIDEOS_FOR_MEMBERS);
  const closed = listen(false);
  try {
    const ask = (server, role) => fetch(`http://127.0.0.1:${server.address().port}/v`, { method: "POST", headers: { "content-type": "application/json", "x-role": role }, body: JSON.stringify({ prompt: "реклама" }) });
    const member = await ask(open, "member");
    assert.equal(member.status, 200);
    assert.equal(member.headers.get("content-type"), "video/mp4");
    assert.equal(Buffer.from(await member.arrayBuffer()).toString(), "MP4");
    const notYet = await ask(closed, "member");
    assert.equal(notYet.status, 403);
    assert.equal((await notYet.json()).code, "VIDEO_NOT_YET_OPEN");
    assert.equal((await ask(closed, "owner")).status, 200);
    assert.deepEqual(made, ["реклама", "реклама"]);
    assert.doesNotMatch(readFileSync(new URL("../public/ui-refresh.css", import.meta.url), "utf8"), /\[data-plus="video"\]\s*\{\s*display:\s*none/u);
  } finally {
    open.close();
    closed.close();
  }
});

test("a made video has an Upload to YouTube button that sends the MP4 to the person's own channel", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const page = read("../public/daily-plan.js");
  assert.match(page, /\/api\/google\/youtube\?title=/u);
  assert.match(page, /"Content-Type": "video\/mp4"/u);
  assert.match(page, /Качи в YouTube/u);
  assert.match(read("../public/locale-en.js"), /^Качи в YouTube\|Upload to YouTube$/mu);
  const router = read("../src/routes/googleDriveRouter.js");
  assert.match(router, /router\.post\("\/youtube", express\.raw\(\{ type: "video\/mp4", limit: "64mb" \}\)/u);
  assert.match(router, /googleConnectPath\("publish"\)/u);
});

test("the connector makes a video and saves it to the owner's Google Drive", async () => {
  const { MCP_CAPABILITY_TOOLS, createMcpCapabilityHandler } = await import("../src/services/mcpCapabilityService.js");
  const { requiredScopesForMcpTool, MCP_MEDIA_WRITE_SCOPE, CLAUDE_SCOPES } = await import("../src/services/mcpOAuthService.js");
  assert.ok(MCP_CAPABILITY_TOOLS.some(({ name }) => name === "generate_video"));
  assert.deepEqual(requiredScopesForMcpTool("generate_video"), [MCP_MEDIA_WRITE_SCOPE]);
  // The Claude connector must be able to get it (it was refused with 403).
  assert.ok(CLAUDE_SCOPES.includes(MCP_MEDIA_WRITE_SCOPE));
  const saved = [];
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    resolveLatestGoogleSession: async () => "main-session",
    dependencies: {
      generateVideo: async (prompt, options) => ({
        video: Buffer.from("MP4"),
        mimeType: "video/mp4",
        prompt,
        model: "gemini-omni-1.1-flash",
        aspectRatio: options.aspectRatio || "16:9",
      }),
      fileSaveSessionFor: async (id) => `${id}-save`,
      saveVideoToDrive: async (id, file) => (saved.push([id, file.name, file.bytes.toString()]), { id: "f1", name: "x.mp4", url: "https://drive.google.com/file/d/f1/view" }),
    },
  });
  const { result } = await handler("generate_video", { prompt: "реклама за кафене", aspectRatio: "9:16" }, { ownerId: "owner" });
  assert.deepEqual(saved, [["main-session-save", "реклама за кафене", "MP4"]]);
  assert.equal(result.structuredContent.file.url, "https://drive.google.com/file/d/f1/view");
  assert.match(result.content[0].text, /9:16.*Google Drive.*Нищо не е публикувано/u);
});

test("a video goes to Drive with a resumable upload", async () => {
  const { saveVideoToDrive } = await import("../src/services/googleDriveService.js");
  assert.equal(typeof saveVideoToDrive, "function");
  await assert.rejects(() => saveVideoToDrive("s", { bytes: Buffer.alloc(0) }), { code: "GOOGLE_SAVE_INVALID" });
  assert.match(readFileSync(new URL("../src/services/googleDriveService.js", import.meta.url), "utf8"), /uploadType=resumable/u);
});

test("the connector uploads a Drive video to YouTube, private unless asked, only after the upload step", async () => {
  const { createMcpCapabilityHandler } = await import("../src/services/mcpCapabilityService.js");
  const { requiredScopesForMcpTool, MCP_MEDIA_WRITE_SCOPE } = await import("../src/services/mcpOAuthService.js");
  assert.deepEqual(requiredScopesForMcpTool("publish_video_to_youtube"), [MCP_MEDIA_WRITE_SCOPE]);
  const uploads = [];
  const make = (publishId) =>
    createMcpCapabilityHandler({
      audit: async () => {},
      resolveLatestGoogleSession: async () => "main",
      dependencies: {
        publishSessionFor: async () => publishId,
        saveSessionFor: async () => "save",
        downloadOwnDriveVideo: async (id, fileId) => ({ name: `клип ${id} ${fileId}`, bytes: Buffer.from("MP4") }),
        uploadVideoToYoutube: async (id, video) => (uploads.push([id, video.title, video.privacy]), { id: "y1", url: "https://www.youtube.com/watch?v=y1", privacy: video.privacy }),
      },
    });
  await assert.rejects(() => make(null)("publish_video_to_youtube", { driveFileId: "file1" }, { ownerId: "owner" }), /add=publish/u);
  const { result } = await make("pub")("publish_video_to_youtube", { driveFileId: "file1" }, { ownerId: "owner" });
  assert.deepEqual(uploads, [["pub", "клип save file1", "private"]]);
  assert.match(result.content[0].text, /YouTube \(private\): https:\/\/www\.youtube\.com\/watch\?v=y1/u);
});

test("the YouTube upload step asks only for youtube.upload in its own token", async () => {
  const { GOOGLE_EXTRA_SCOPES, GOOGLE_LINKED_EXTRAS, uploadVideoToYoutube } = await import("../src/services/googleDriveService.js");
  assert.equal(GOOGLE_EXTRA_SCOPES.publish, "https://www.googleapis.com/auth/youtube.upload");
  assert.ok(GOOGLE_LINKED_EXTRAS.includes("publish"));
  await assert.rejects(() => uploadVideoToYoutube("s", { bytes: Buffer.alloc(0) }), { code: "YOUTUBE_UPLOAD_INVALID" });
});

test("a failed video says Google's status word, and the connector shows that message", async () => {
  const service = createVideoGenerationService({
    env: { GEMINI_API_KEY: "secret-key" },
    reserve: async () => async () => true,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { status: "NOT_FOUND", message: "model secret-key not found" } }) }),
  });
  await assert.rejects(
    () => service.generate("реклама"),
    (error) => error.name === "VideoGenerationError" && /Gemini: 404 NOT_FOUND/u.test(error.message) && !/secret/u.test(error.message),
  );
  assert.match(readFileSync(new URL("../src/services/mcpReadService.js", import.meta.url), "utf8"), /"VideoGenerationError"/u);
});

test("when the Gemini key has no video quota, Vertex AI Veo makes the clip", async () => {
  const calls = [];
  const service = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k", VERTEX_AI_PROJECT_ID: "handy-project-123" },
    reserve: async () => async () => calls.push("refund"),
    sleep: async () => {},
    vertexAuthorization: async () => "Bearer adc",
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push(url.replace(/^https:\/\/[^/]+/u, ""));
      if (url.includes("generativelanguage")) return { ok: false, status: 429, json: async () => ({ error: { code: 429 } }) };
      assert.equal(options.headers.Authorization, "Bearer adc");
      if (url.includes("veo-3.1-fast-generate-001:predictLongRunning")) return { ok: false, status: 404, json: async () => ({ error: { status: "NOT_FOUND" } }) };
      if (url.endsWith(":predictLongRunning")) {
        assert.deepEqual(body.parameters, { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", generateAudio: true, sampleCount: 1 });
        return ok({ name: "op1" });
      }
      assert.equal(body.operationName, "op1");
      return calls.filter((c) => c.endsWith(":fetchPredictOperation")).length < 2
        ? ok({ done: false })
        : ok({ done: true, response: { videos: [{ bytesBase64Encoded: Buffer.from("VEO").toString("base64") }] } });
    },
  });
  const result = await service.generate("реклама за TikTok");
  assert.equal(result.video.toString(), "VEO");
  assert.equal(result.model, "veo-3.1-lite-generate-001");
  assert.ok(calls.some((c) => c.includes("/projects/handy-project-123/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001:predictLongRunning")));
  assert.ok(!calls.includes("refund"));
});

test("a Vertex safety filter is a refusal and gives the units back", async () => {
  let refunds = 0;
  const service = createVideoGenerationService({
    env: { VERTEX_AI_PROJECT_ID: "handy-project-123" },
    reserve: async () => async () => refunds++,
    sleep: async () => {},
    vertexAuthorization: async () => "Bearer adc",
    fetchImpl: async (url) =>
      url.endsWith(":predictLongRunning") ? ok({ name: "op" }) : ok({ done: true, response: { raiMediaFilteredCount: 1, videos: [] } }),
  });
  await assert.rejects(() => service.generate("нещо"), { code: "VIDEO_REFUSED" });
  assert.equal(refunds, 1);
});

test("no video is made (and paid for) when it cannot be saved to Drive", async () => {
  const { createMcpCapabilityHandler } = await import("../src/services/mcpCapabilityService.js");
  let made = 0;
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    resolveLatestGoogleSession: async () => "main",
    dependencies: { fileSaveSessionFor: async () => null, generateVideo: async () => made++ },
  });
  await assert.rejects(() => handler("generate_video", { prompt: "реклама" }, { ownerId: "owner" }), /add=save/u);
  assert.equal(made, 0);
});
