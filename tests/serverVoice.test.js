import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseAudioPayload,
  transcribeVoice,
} from "../src/services/voiceTranscriptionService.js";

const audio = Buffer.alloc(2000, 7).toString("base64");

test("only known audio formats and sizes are accepted", () => {
  assert.equal(parseAudioPayload({ audio, mimeType: "audio/mp4" }).extension, "mp4");
  assert.equal(parseAudioPayload({ audio, mimeType: "audio/webm;codecs=opus" }).type, "audio/webm");
  assert.throws(() => parseAudioPayload({ audio, mimeType: "video/mp4" }), { code: "VOICE_FORMAT" });
  assert.throws(() => parseAudioPayload({ audio: "", mimeType: "audio/mp4" }), { code: "VOICE_SIZE" });
  assert.throws(
    () => parseAudioPayload({ audio: "A".repeat(6_000_000), mimeType: "audio/mp4" }),
    { code: "VOICE_SIZE" },
  );
});

const VERTEX_ENV = Object.freeze({
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "project-123",
  VERTEX_AI_LOCATION: "global",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
});
const authClient = { getRequestHeaders: async () => ({ Authorization: "Bearer test" }) };

test("Vertex Gemini transcribes with the chosen language", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    const body = JSON.parse(init.body);
    assert.match(body.contents[0].parts[0].text, /език: bg/u);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, "audio/mp4");
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "Добро утро" }] } }] }),
      { status: 200 },
    );
  };
  const result = await transcribeVoice(
    { audio, mimeType: "audio/mp4", language: "bg" },
    { env: VERTEX_ENV, fetchImpl, authClient },
  );
  assert.deepEqual([result.provider, result.text], ["vertex-gemini", "Добро утро"]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /aiplatform\.googleapis\.com/u);
});

test("no provider means a clear 503", async () => {
  await assert.rejects(
    transcribeVoice({ audio, mimeType: "audio/mp4" }, { env: {} }),
    { code: "VOICE_NOT_CONFIGURED", status: 503 },
  );
});

test("the page records on iPhone and sends the recording to the server", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(app, /function prefersServerVoice/);
  assert.match(app, /iPad\|iPhone\|iPod/);
  assert.match(app, /new MediaRecorder\(stream/);
  assert.match(app, /fetch\("\/api\/voice\/transcribe"/);
  assert.match(app, /"service-not-allowed", "network", "language-not-supported"/);
  assert.match(server, /"\/api\/voice",\s*requireOwnerSession,\s*paidAiRateLimiter,\s*publicAiBudgetContext/);
});
