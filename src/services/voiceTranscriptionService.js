import { reportAiUsage } from "./novariumService.js";
import { reservePublicAiVoice } from "./publicAiBudget.js";
import { ProductError } from "./productPlansService.js";

// Speech to text on the server, for phones where the browser's own speech
// recognition is missing or does not speak Bulgarian (iPhone Safari, the
// home-screen app). Gemini first, OpenAI as the fallback (РАДКО 28.11.2026).
export const DEFAULT_OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
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

async function transcribeWithOpenAi({ bytes, type, extension, language, env, fetchImpl, signal }) {
  const model = env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_OPENAI_TRANSCRIBE_MODEL;
  await reservePublicAiVoice("openai", model);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), `voice.${extension}`);
  form.append("model", model);
  form.append("language", languageCode(language));
  form.append("response_format", "json");
  const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
    signal,
  });
  if (!response.ok) {
    throw new VoiceError(`OpenAI върна грешка ${response.status}.`, 502, "VOICE_UPSTREAM");
  }
  const data = await response.json();
  reportAiUsage("openai", model, data?.usage?.input_tokens || 0, data?.usage?.output_tokens || 0);
  return { text: String(data?.text || "").trim(), provider: "openai", model };
}

async function transcribeWithGemini({ bytes, type, language, env, fetchImpl, signal }) {
  const model = env.GEMINI_TRANSCRIBE_MODEL || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  await reservePublicAiVoice("gemini", model);
  const base = String(env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "");
  const response = await fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: type, data: bytes.toString("base64") } },
            {
              text: `Запиши точно казаното в аудиото като текст (език: ${languageCode(language)}). Върни само текста, без обяснения. Ако няма реч, върни празен отговор.`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
    }),
    signal,
  });
  if (!response.ok) {
    throw new VoiceError(`Gemini върна грешка ${response.status}.`, 502, "VOICE_UPSTREAM");
  }
  const data = await response.json();
  reportAiUsage(
    "gemini",
    model,
    data?.usageMetadata?.promptTokenCount || 0,
    data?.usageMetadata?.candidatesTokenCount || 0,
  );
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("")
    .trim();
  return { text, provider: "gemini", model };
}

export async function transcribeVoice(payload, { env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const audio = parseAudioPayload(payload);
  const providers = [
    env.GEMINI_API_KEY ? transcribeWithGemini : null,
    env.OPENAI_API_KEY ? transcribeWithOpenAi : null,
  ].filter(Boolean);
  if (!providers.length) {
    throw new VoiceError("Гласовото разпознаване на сървъра не е настроено.", 503, "VOICE_NOT_CONFIGURED");
  }
  let lastError;
  for (const provider of providers) {
    try {
      return await provider({
        ...audio,
        language: payload?.language,
        env,
        fetchImpl,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Out of credits is an answer, not a provider failure.
      if (error instanceof ProductError) throw error;
      lastError = error;
      console.error(`[Voice] ${provider.name} failed: ${error?.code || error?.name || "error"}`);
    }
  }
  throw lastError instanceof VoiceError
    ? lastError
    : new VoiceError("Записът не можа да се разпознае. Опитай пак.", 502, "VOICE_FAILED");
}
