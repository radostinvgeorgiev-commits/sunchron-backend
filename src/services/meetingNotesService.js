import { DEFAULT_GEMINI_API_URL, DEFAULT_GEMINI_CHAT_MODEL } from "./aiCoreService.js";
import { reservePublicAiMeeting } from "./publicAiBudget.js";
import { ProductError } from "./productPlansService.js";

// A meeting recording becomes text, a short summary, decisions and tasks, like
// Read AI or Otter. Gemini reads the recording through its Files API (long
// audio, up to the upload limit); if that fails, OpenAI's speech-to-text reads
// it (files up to 25 MB) and Gemini only writes the summary from the text.

export const MAX_MEETING_BYTES = 30 * 1024 * 1024;
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

const MEETING_TYPES = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "aac"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/flac", "flac"],
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["video/webm", "webm"],
]);

export class MeetingError extends Error {
  constructor(message, status = 502, code = "MEETING_FAILED") {
    super(message);
    this.name = "MeetingError";
    this.status = status;
    this.code = code;
  }
}

export function parseMeetingUpload({ bytes, mimeType, name } = {}) {
  const type = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (!MEETING_TYPES.has(type)) {
    throw new MeetingError("Този формат на записа не се поддържа. Ползвай m4a, mp3, wav или видео mp4.", 415, "MEETING_FORMAT");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 200) {
    throw new MeetingError("Записът е празен.", 400, "MEETING_EMPTY");
  }
  if (bytes.length > MAX_MEETING_BYTES) {
    throw new MeetingError("Записът е над 30 MB. Изпрати по-кратък запис или само звука.", 413, "MEETING_TOO_LARGE");
  }
  const cleanName = String(name || "").replace(/[\u0000-\u001f]/gu, "").trim().slice(0, 80) || `запис.${MEETING_TYPES.get(type)}`;
  // Gemini names m4a audio "audio/mp4".
  const geminiType = ["audio/m4a", "audio/x-m4a"].includes(type) ? "audio/mp4" : type === "audio/mp3" ? "audio/mpeg" : type;
  return { bytes, type, geminiType, extension: MEETING_TYPES.get(type), name: cleanName };
}

function geminiBase(env) {
  return String(env.GEMINI_API_URL || DEFAULT_GEMINI_API_URL).replace(/\/+$/u, "");
}

function geminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

async function uploadToGemini(upload, { env, fetchImpl }) {
  const base = geminiBase(env);
  const uploadBase = base.replace(/\/v1(?:beta)?$/u, "/upload$&");
  const start = await fetchImpl(`${uploadBase}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(upload.bytes.length),
      "X-Goog-Upload-Header-Content-Type": upload.geminiType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "meeting" } }),
  });
  const target = start.ok ? start.headers.get("x-goog-upload-url") : "";
  if (!target) throw new MeetingError(`Качването на записа не започна (${start.status}).`, 502, "MEETING_UPLOAD");
  const done = await fetchImpl(target, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Length": String(upload.bytes.length),
    },
    body: upload.bytes,
  });
  if (!done.ok) throw new MeetingError(`Качването на записа не завърши (${done.status}).`, 502, "MEETING_UPLOAD");
  let file = (await done.json())?.file;
  // Video is processed before it can be read; audio is usually ready at once.
  for (let attempt = 0; file?.state === "PROCESSING" && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, env.MEETING_POLL_MS ? Number(env.MEETING_POLL_MS) : 2000));
    const check = await fetchImpl(`${base}/${file.name}`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    if (check.ok) file = await check.json();
  }
  if (!file?.uri || file.state === "FAILED" || file.state === "PROCESSING") {
    throw new MeetingError("Записът не можа да се обработи.", 502, "MEETING_PROCESSING");
  }
  return file;
}

async function transcribeWithGemini(upload, { env, fetchImpl }) {
  const model = env.GEMINI_MEETING_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL;
  const file = await uploadToGemini(upload, { env, fetchImpl });
  try {
    const response = await fetchImpl(`${geminiBase(env)}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { fileData: { fileUri: file.uri, mimeType: file.mimeType || upload.geminiType } },
              {
                text: "Запиши дословно казаното в записа, на езика, на който се говори. Когато говорещите се сменят, започни нов ред с „Говорител 1:“, „Говорител 2:“ и т.н. Върни само текста. Ако няма реч, върни празен отговор.",
              },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 32768 },
      }),
    });
    if (!response.ok) throw new MeetingError(`Gemini върна грешка ${response.status}.`, 502, "MEETING_UPSTREAM");
    return { text: geminiText(await response.json()), provider: "gemini", model };
  } finally {
    fetchImpl(`${geminiBase(env)}/${file.name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    }).catch(() => {});
  }
}

async function transcribeWithOpenAi(upload, { env, fetchImpl }) {
  if (upload.bytes.length > OPENAI_MAX_BYTES) {
    throw new MeetingError("Записът е над 25 MB.", 413, "MEETING_TOO_LARGE");
  }
  const model = env.OPENAI_MEETING_TRANSCRIBE_MODEL || "whisper-1";
  const form = new FormData();
  form.append("file", new Blob([upload.bytes], { type: upload.type }), `meeting.${upload.extension}`);
  form.append("model", model);
  form.append("response_format", "json");
  const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) throw new MeetingError(`OpenAI върна грешка ${response.status}.`, 502, "MEETING_UPSTREAM");
  const data = await response.json();
  return { text: String(data?.text || "").trim(), provider: "openai", model };
}

export async function transcribeMeeting(upload, { env = process.env, fetchImpl = fetch } = {}) {
  const providers = [
    env.GEMINI_API_KEY ? transcribeWithGemini : null,
    env.OPENAI_API_KEY ? transcribeWithOpenAi : null,
  ].filter(Boolean);
  if (!providers.length) {
    throw new MeetingError("Разпознаването на записи не е настроено.", 503, "MEETING_NOT_CONFIGURED");
  }
  let lastError;
  for (const provider of providers) {
    try {
      return await provider(upload, { env, fetchImpl });
    } catch (error) {
      lastError = error;
      console.error(`[Meeting] ${provider.name} failed: ${error?.code || error?.name || "error"} ${error?.message || ""}`.slice(0, 300));
    }
  }
  throw lastError instanceof MeetingError
    ? lastError
    : new MeetingError("Записът не можа да се разпознае. Опитай пак.", 502, "MEETING_FAILED");
}

function cleanList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").replace(/\s+/gu, " ").trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, limit);
}

export function parseMeetingSummary(raw) {
  let data = {};
  try {
    data = JSON.parse(String(raw || "").replace(/^```(?:json)?\s*|\s*```$/gu, ""));
  } catch {
    data = { summary: String(raw || "").trim() };
  }
  return {
    title: String(data.title || "").replace(/\s+/gu, " ").trim().slice(0, 80) || "Среща",
    summary: String(data.summary || "").trim().slice(0, 3000),
    decisions: cleanList(data.decisions, 12),
    tasks: cleanList(data.tasks, 20),
  };
}

export async function summarizeMeetingText(transcript, { env = process.env, fetchImpl = fetch } = {}) {
  const model = env.GEMINI_MEETING_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_CHAT_MODEL;
  const response = await fetchImpl(`${geminiBase(env)}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: [
              "Ти обобщаваш запис от среща или разговор за човека, който го е качил. Пиши на български.",
              'Върни само JSON: {"title":"кратко заглавие","summary":"3–6 изречения: за какво стана дума","decisions":["решено ..."],"tasks":["кой какво да направи и до кога, ако е казано"]}.',
              "Не измисляй неща, които не са казани. Ако няма решения или задачи, върни празни списъци.",
            ].join("\n"),
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: transcript.slice(0, 400_000) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 },
    }),
  });
  if (!response.ok) throw new MeetingError(`Обобщението не успя (${response.status}).`, 502, "MEETING_SUMMARY");
  return parseMeetingSummary(geminiText(await response.json()));
}

export function formatMeetingNotes(notes) {
  const lines = [`## ${notes.title}`, "", notes.summary || "—"];
  if (notes.decisions.length) lines.push("", "**Решения:**", ...notes.decisions.map((item) => `- ${item}`));
  if (notes.tasks.length) lines.push("", "**Задачи:**", ...notes.tasks.map((item) => `- ${item}`));
  return lines.join("\n");
}

export async function processMeetingRecording(payload, { env = process.env, fetchImpl = fetch, transcribe = transcribeMeeting, summarize = summarizeMeetingText } = {}) {
  const upload = parseMeetingUpload(payload);
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
    throw new MeetingError("Разпознаването на записи не е настроено.", 503, "MEETING_NOT_CONFIGURED");
  }
  await reservePublicAiMeeting(upload.bytes.length, "gemini", "meeting");
  const transcript = await transcribe(upload, { env, fetchImpl });
  if (!transcript.text) {
    throw new MeetingError("В записа не се чува реч.", 422, "MEETING_NO_SPEECH");
  }
  let notes;
  try {
    notes = env.GEMINI_API_KEY ? await summarize(transcript.text, { env, fetchImpl }) : null;
  } catch (error) {
    if (error instanceof ProductError) throw error;
    console.error(`[Meeting] summary failed: ${error?.code || "error"}`);
  }
  notes ||= parseMeetingSummary(JSON.stringify({ title: upload.name, summary: "Обобщението не се получи; текстът на записа е запазен." }));
  return { ...notes, transcript: transcript.text, name: upload.name, provider: transcript.provider };
}
