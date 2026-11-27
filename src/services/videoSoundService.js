// Voice and music for AI CORE videos: a short spoken line (Gemini speech),
// background music (Vertex AI Lyria) and a mix with ffmpeg. Every step is
// best effort: when one fails, the video is returned as it was made.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGoogleAuthClient } from "./googleAdcAuth.js";
import { resolveVertexAiProjectId } from "./vertexAiGeminiService.js";
import { logSafeError } from "../utils/safeLogging.js";

const run = promisify(execFile);
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_SPEECH_MODEL = "gemini-3.8-flash-tts";
export const DEFAULT_SPEECH_VOICE = "Kore";
export const DEFAULT_SCRIPT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_MUSIC_MODEL = "lyria-002";
const MUSIC_LOCATION = "us-central1";
const MAX_NARRATION_CHARS = 400;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function cleanNarration(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/["„“”*#_`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_NARRATION_CHARS);
}

// Raw 16-bit mono PCM (what Gemini speech returns) as a WAV file.
export function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function findAudio(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const mime = String(value.mime_type || value.mimeType || "");
  if (typeof value.data === "string" && value.data.length > 100 && (value.type === "audio" || mime.startsWith("audio/"))) {
    return { data: value.data, mime };
  }
  const inline = value.inline_data || value.inlineData;
  if (inline?.data) return { data: inline.data, mime: String(inline.mime_type || inline.mimeType || "") };
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findAudio(item, depth + 1);
    if (found) return found;
  }
  return null;
}

// The filter that lays the voice and music over the video's own sound.
export function buildMixFilter({ duration, hasVideoAudio, hasMusic, narrationSeconds }) {
  const room = Math.max(1, duration - 0.8);
  const tempo = narrationSeconds > room ? Math.min(1.35, narrationSeconds / room) : 1;
  const parts = [];
  const labels = [];
  let input = 1;
  if (hasVideoAudio) {
    parts.push("[0:a]volume=0.3[a0]");
    labels.push("[a0]");
  }
  parts.push(`[${input}:a]${tempo > 1 ? `atempo=${tempo.toFixed(3)},` : ""}adelay=400|400,volume=1.0[vo]`);
  labels.push("[vo]");
  input += 1;
  if (hasMusic) {
    const fadeAt = Math.max(0, duration - 1.5).toFixed(2);
    parts.push(`[${input}:a]atrim=0:${duration.toFixed(2)},volume=0.35,afade=t=in:d=0.5,afade=t=out:st=${fadeAt}:d=1.5[mu]`);
    labels.push("[mu]");
  }
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,atrim=0:${duration.toFixed(2)}[aout]`);
  return parts.join(";");
}

export function createVideoSoundService({
  env = process.env,
  fetchImpl = fetch,
  exec = run,
  vertexAuthorization = async (url) => {
    const client = await createGoogleAuthClient();
    const headers = await client.getRequestHeaders(url);
    return typeof headers?.get === "function" ? headers.get("authorization") : headers?.Authorization || headers?.authorization;
  },
} = {}) {
  const geminiHeaders = () => ({ "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY });

  async function writeNarration(prompt) {
    const model = env.VIDEO_SCRIPT_MODEL || DEFAULT_SCRIPT_MODEL;
    const response = await fetchImpl(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: geminiHeaders(),
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Напиши един кратък глас зад кадър за 8-секундно видео по това описание. Най-много 16 думи, на езика на описанието (по подразбиране български), естествено и топло, без кавички и без обяснения.\n\nОписание: ${prompt}`,
          }],
        }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 120 },
      }),
    });
    if (!response.ok) throw new Error(`script ${response.status}`);
    const data = await response.json();
    return cleanNarration((data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join(" "));
  }

  async function speak(text) {
    const model = env.VIDEO_SPEECH_MODEL || DEFAULT_SPEECH_MODEL;
    const voice = /^[A-Z][a-z]{2,20}$/u.test(env.VIDEO_SPEECH_VOICE || "") ? env.VIDEO_SPEECH_VOICE : DEFAULT_SPEECH_VOICE;
    const response = await fetchImpl(`${API_BASE}/interactions`, {
      method: "POST",
      headers: geminiHeaders(),
      body: JSON.stringify({
        model,
        input: [{ type: "user_input", content: [{ type: "text", text }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!response.ok) throw new Error(`speech ${response.status}`);
    const audio = findAudio(await response.json());
    if (!audio) throw new Error("speech empty");
    let bytes = Buffer.from(audio.data, "base64");
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error("speech size");
    if (bytes.subarray(0, 4).toString() !== "RIFF") {
      const rate = Number(audio.mime.match(/rate=(\d{4,6})/u)?.[1]) || 24000;
      bytes = pcmToWav(bytes, rate);
    }
    return bytes;
  }

  async function music(prompt) {
    const projectId = resolveVertexAiProjectId(env);
    if (!projectId) throw new Error("music not configured");
    const model = /^[a-z][a-z0-9.-]{0,63}$/u.test(env.VIDEO_MUSIC_MODEL || "") ? env.VIDEO_MUSIC_MODEL : DEFAULT_MUSIC_MODEL;
    const url = `https://${MUSIC_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${MUSIC_LOCATION}/publishers/google/models/${model}:predict`;
    const authorization = await vertexAuthorization(url);
    if (!authorization) throw new Error("music no access");
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        instances: [{ prompt: `Instrumental background music, modern, warm and upbeat, no vocals, for a short video about: ${prompt.slice(0, 300)}` }],
        parameters: { sample_count: 1 },
      }),
    });
    if (!response.ok) throw new Error(`music ${response.status}`);
    const data = await response.json();
    const encoded = data?.predictions?.[0]?.bytesBase64Encoded || data?.predictions?.[0]?.audioContent;
    const bytes = Buffer.from(String(encoded || ""), "base64");
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error("music empty");
    return bytes;
  }

  async function mix(video, voiceWav, musicWav) {
    const dir = await mkdtemp(join(tmpdir(), "aicore-sound-"));
    try {
      const files = { video: join(dir, "in.mp4"), voice: join(dir, "voice.wav"), music: join(dir, "music.wav"), out: join(dir, "out.mp4") };
      await writeFile(files.video, video);
      await writeFile(files.voice, voiceWav);
      if (musicWav) await writeFile(files.music, musicWav);
      const probe = async (file) => JSON.parse((await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeout: 20000 })).stdout || "{}");
      const [videoInfo, voiceInfo] = await Promise.all([probe(files.video), probe(files.voice)]);
      const duration = Number(videoInfo?.format?.duration) || 8;
      const filter = buildMixFilter({
        duration,
        hasVideoAudio: (videoInfo?.streams || []).some((stream) => stream.codec_type === "audio"),
        hasMusic: Boolean(musicWav),
        narrationSeconds: Number(voiceInfo?.format?.duration) || 0,
      });
      const args = ["-y", "-v", "error", "-i", files.video, "-i", files.voice];
      if (musicWav) args.push("-i", files.music);
      args.push("-filter_complex", filter, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", files.out);
      await exec("ffmpeg", args, { timeout: 60000 });
      const out = await readFile(files.out);
      if (!out.length) throw new Error("mix empty");
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Returns { video, narration, music } — the original video when sound fails.
  async function addSound(video, prompt, options = {}) {
    if (!env.GEMINI_API_KEY || options.sound === false || env.VIDEO_SOUND === "off") return { video, narration: "", music: false };
    try {
      const narration = cleanNarration(options.narration) || (await writeNarration(prompt));
      if (!narration) return { video, narration: "", music: false };
      const [voiceWav, musicWav] = await Promise.all([
        speak(narration),
        options.music === false ? null : music(prompt).catch((error) => {
          logSafeError("[Video sound] music skipped", error);
          return null;
        }),
      ]);
      return { video: await mix(video, voiceWav, musicWav), narration, music: Boolean(musicWav) };
    } catch (error) {
      logSafeError("[Video sound] skipped", error);
      return { video, narration: "", music: false };
    }
  }

  return { addSound, writeNarration, speak, music, mix };
}

let defaultService;
export function getVideoSoundService() {
  return (defaultService ||= createVideoSoundService());
}
