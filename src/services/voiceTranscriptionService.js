import { requestAiResponse } from "./novariumService.js";
import { isVertexAiConfigured, resolveVertexAiModel } from "./vertexAiGeminiService.js";
import { reservePublicAiVoice } from "./publicAiBudget.js";
import { ProductError } from "./productPlansService.js";

// Speech to text on the server, for phones where the browser's own speech
// recognition is missing or does not speak Bulgarian (iPhone Safari, the
// home-screen app). Server transcription uses only Vertex Gemini.
export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-flash-lite";
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);

export class VoiceError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseAudioPayload({ audio, mimeType } = {}) {
  const type = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (!AUDIO_TYPES.has(type)) {
    throw new VoiceError("Този аудио формат не се поддържа.", 415, "VOICE_FORMAT");
  }
  if (typeof audio !== "string" || !audio || audio.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8) {
    throw new VoiceError("Записът е празен или твърде дълъг (до около 2 минути).", 413, "VOICE_SIZE");
  }
  const bytes = Buffer.from(audio, "base64");
  if (bytes.length < 200 || bytes.length > MAX_AUDIO_BYTES) {
    throw new VoiceError("Записът е празен или твърде дълъг (до около 2 минути).", 413, "VOICE_SIZE");
  }
  return { bytes, type, extension: AUDIO_TYPES.get(type) };
}

function languageCode(language) {
  const value = String(language || "bg").slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/u.test(value) ? value : "bg";
}

async function transcribeWithVertex({ bytes, type, language, env, fetchImpl, signal, authClient }) {
  const model = env.GEMINI_TRANSCRIBE_MODEL || resolveVertexAiModel(env);
  await reservePublicAiVoice("vertex-gemini", model);
  const response = await requestAiResponse({
    provider: "vertex-gemini",
    env,
    model,
    input: [{
      role: "user",
      content: `Запиши точно казаното в аудиото като текст (език: ${languageCode(language)}). Върни само текста, без обяснения. Ако няма реч, върни празен отговор.`,
    }],
    fetchImpl,
    signal,
    authClient,
    mediaParts: [{ inlineData: { mimeType: type, data: bytes.toString("base64") } }],
    maxOutputTokens: 1024,
  });
  return { text: String(response?.text || "").trim(), provider: "vertex-gemini", model: response?.model || model };
}

export async function transcribeVoice(payload, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000, authClient } = {}) {
  const audio = parseAudioPayload(payload);
  if (!isVertexAiConfigured(env)) {
    throw new VoiceError("Гласовото разпознаване на сървъра не е настроено.", 503, "VOICE_NOT_CONFIGURED");
  }
  try {
    return await transcribeWithVertex({
      ...audio,
      language: payload?.language,
      env,
      fetchImpl,
      authClient,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof ProductError) throw error;
    console.error(`[Voice] Vertex failed: ${error?.code || error?.name || "error"}`);
    throw error instanceof VoiceError
      ? error
      : new VoiceError("Записът не можа да се разпознае. Опитай пак.", 502, "VOICE_FAILED");
  }
}
