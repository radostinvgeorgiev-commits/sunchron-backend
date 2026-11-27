import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildMixFilter, cleanNarration, createVideoSoundService, pcmToWav } from "../src/services/videoSoundService.js";
import { createVideoGenerationService } from "../src/services/videoGenerationService.js";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);

function json(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

test("narration text is cleaned and kept short", () => {
  assert.equal(cleanNarration('  „Твоят AI   аватар“ *винаги* с теб\n'), "Твоят AI аватар винаги с теб");
  assert.equal(cleanNarration("а".repeat(900)).length, 400);
});

test("raw speech PCM becomes a playable WAV", () => {
  const wav = pcmToWav(Buffer.alloc(4800), 24000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + 4800);
});

test("mix filter keeps the clip length and speeds up a long voice", () => {
  const filter = buildMixFilter({ duration: 8, hasVideoAudio: true, hasMusic: true, narrationSeconds: 9 });
  assert.match(filter, /\[0:a\]volume=0.3/u);
  assert.match(filter, /atempo=1\.250/u);
  assert.match(filter, /\[2:a\]atrim=0:8\.00/u);
  assert.match(filter, /amix=inputs=3/u);
  const quiet = buildMixFilter({ duration: 8, hasVideoAudio: false, hasMusic: false, narrationSeconds: 3 });
  assert.doesNotMatch(quiet, /0:a|atempo/u);
  assert.match(quiet, /amix=inputs=1/u);
});

test("sound is skipped without a Gemini key or when turned off", async () => {
  const video = Buffer.from("clip");
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), json({}));
  assert.equal((await createVideoSoundService({ env: {}, fetchImpl }).addSound(video, "реклама")).video, video);
  const off = await createVideoSoundService({ env: { GEMINI_API_KEY: "k" }, fetchImpl }).addSound(video, "реклама", { sound: false });
  assert.equal(off.video, video);
  assert.equal(calls.length, 0);
});

test("a failed voice returns the clip as it was made", async () => {
  const video = Buffer.from("clip");
  const service = createVideoSoundService({
    env: { GEMINI_API_KEY: "k" },
    fetchImpl: async () => json({ error: { status: "PERMISSION_DENIED" } }, 403),
  });
  const result = await service.addSound(video, "реклама", { narration: "Здравей" });
  assert.equal(result.video, video);
  assert.equal(result.narration, "");
});

test("speech request uses Gemini speech with a prebuilt voice", async () => {
  let body;
  const service = createVideoSoundService({
    env: { GEMINI_API_KEY: "k" },
    fetchImpl: async (url, init) => {
      assert.match(url, /\/v1beta\/interactions$/u);
      assert.equal(init.headers["x-goog-api-key"], "k");
      body = JSON.parse(init.body);
      return json({ steps: [{ content: [{ type: "audio", mime_type: "audio/L16;rate=24000", data: Buffer.alloc(960).toString("base64") }] }] });
    },
  });
  const wav = await service.speak("Здравей от NovariumAI");
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.deepEqual(body.response_format, { type: "audio" });
  assert.equal(body.generation_config.speech_config[0].voice, "Kore");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
});

test("video service adds sound when it is wired in", async () => {
  const sounded = Buffer.from("with sound");
  const service = createVideoGenerationService({
    env: { GEMINI_API_KEY: "k" },
    reserve: async () => async () => true,
    fetchImpl: async () => json({ status: "completed", steps: [{ content: [{ type: "video", data: Buffer.from("clip").toString("base64") }] }] }),
    addSound: async (video, prompt, options) => {
      assert.equal(video.toString(), "clip");
      assert.equal(options.narration, "Текст");
      return { video: sounded, narration: "Текст", music: true };
    },
  });
  const made = await service.generate("кратка реклама за NovariumAI", { narration: "Текст" });
  assert.equal(made.video, sounded);
  assert.equal(made.narration, "Текст");
  assert.equal(made.music, true);
});

test("Dockerfile installs ffmpeg for the mix", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ffmpeg/u);
});

test("ffmpeg lays voice and music over a real clip", { skip: !hasFfmpeg && "ffmpeg missing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sound-test-"));
  try {
    const make = async (name, args) => {
      await run("ffmpeg", ["-y", "-v", "error", ...args, join(dir, name)]);
      return readFile(join(dir, name));
    };
    const video = await make("v.mp4", ["-f", "lavfi", "-i", "color=c=blue:s=160x90:d=3", "-f", "lavfi", "-i", "sine=f=220:d=3", "-shortest", "-c:v", "libx264", "-c:a", "aac"]);
    const voice = await make("voice.wav", ["-f", "lavfi", "-i", "sine=f=440:d=1.5"]);
    const music = await make("music.wav", ["-f", "lavfi", "-i", "sine=f=330:d=10"]);
    const out = await createVideoSoundService({ env: {} }).mix(video, voice, music);
    await (await import("node:fs/promises")).writeFile(join(dir, "out.mp4"), out);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", join(dir, "out.mp4")]);
    const info = JSON.parse(stdout);
    assert.ok(info.streams.some((stream) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
