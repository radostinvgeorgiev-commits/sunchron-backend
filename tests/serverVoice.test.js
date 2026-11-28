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

test("OpenAI transcribes in the chosen language", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, form: init.body };
    return new Response(JSON.stringify({ text: " Здравей, как си? " }), { status: 200 });
  };
  const result = await transcribeVoice(
    { audio, mimeType: "audio/mp4", language: "bg" },
    { env: { OPENAI_API_KEY: "k" }, fetchImpl },
  );
  assert.equal(result.text, "Здравей, как си?");
  assert.equal(result.provider, "openai");
  assert.match(seen.url, /audio\/transcriptions$/u);
  assert.equal(seen.form.get("language"), "bg");
  assert.equal(seen.form.get("model"), "gpt-4o-mini-transcribe");
});

test("Gemini goes first when both keys are set", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "Добро утро" }] } }] }),
      { status: 200 },
    );
  };
  const result = await transcribeVoice(
    { audio, mimeType: "audio/webm" },
    { env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" }, fetchImpl },
  );
  assert.deepEqual([result.provider, result.text], ["gemini", "Добро утро"]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /generativelanguage\.googleapis\.com/u);
});

test("OpenAI answers when Gemini fails", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.includes("generativelanguage")
      ? new Response("{}", { status: 429 })
      : new Response(JSON.stringify({ text: "Добро утро" }), { status: 200 });
  };
  const result = await transcribeVoice(
    { audio, mimeType: "audio/webm" },
    { env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" }, fetchImpl },
  );
  assert.deepEqual([result.provider, result.text], ["openai", "Добро утро"]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /api\.openai\.com/u);
});

// A refusal or a cut-off answer comes back from Gemini as 200 with no text;
// the fallback must still hear the recording (review of #605). Silence that
// simply stopped stays an empty answer from Gemini.
test("OpenAI answers when Gemini returns no text", async () => {
  for (const body of [
    { candidates: [{ finishReason: "RECITATION" }] },
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] },
    { promptFeedback: { blockReason: "OTHER" } },
  ]) {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return url.includes("generativelanguage")
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response(JSON.stringify({ text: "Добро утро" }), { status: 200 });
    };
    const result = await transcribeVoice(
      { audio, mimeType: "audio/webm" },
      { env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" }, fetchImpl },
    );
    assert.deepEqual([result.provider, result.text, urls.length], ["openai", "Добро утро", 2], JSON.stringify(body));
  }
  const silence = await transcribeVoice(
    { audio, mimeType: "audio/webm" },
    {
      env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" },
      fetchImpl: async () =>
        new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] }), { status: 200 }),
    },
  );
  assert.deepEqual([silence.provider, silence.text], ["gemini", ""]);
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
