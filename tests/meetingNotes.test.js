import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMeetingNotes,
  parseMeetingSummary,
  parseMeetingUpload,
  processMeetingRecording,
  transcribeMeeting,
} from "../src/services/meetingNotesService.js";
import { meetingCredits } from "../src/services/publicAiBudget.js";
import { createMeetingNotesHandler } from "../src/routes/chat.js";

const env = { GEMINI_API_KEY: "g", GEMINI_API_URL: "https://gemini.test/v1beta", MEETING_POLL_MS: "1" };
const audio = Buffer.alloc(4096, 7);

test("a phone voice memo is accepted, other files are not", () => {
  const upload = parseMeetingUpload({ bytes: audio, mimeType: "audio/x-m4a", name: "среща.m4a" });
  assert.equal(upload.geminiType, "audio/mp4");
  assert.equal(upload.name, "среща.m4a");
  assert.throws(() => parseMeetingUpload({ bytes: audio, mimeType: "application/pdf" }), /формат/u);
  assert.throws(() => parseMeetingUpload({ bytes: Buffer.alloc(10), mimeType: "audio/mpeg" }), /празен/u);
  assert.throws(
    () => parseMeetingUpload({ bytes: Buffer.alloc(31 * 1024 * 1024), mimeType: "audio/mpeg" }),
    /30 MB/u,
  );
});

test("a meeting costs 2 units per started 10 MB", () => {
  assert.equal(meetingCredits(4096), 2);
  assert.equal(meetingCredits(10 * 1024 * 1024 + 1), 4);
  assert.equal(meetingCredits(29 * 1024 * 1024), 6);
});

test("Gemini reads the recording through its Files API and the file is deleted after", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", headers: options.headers || {} });
    if (url.endsWith("/upload/v1beta/files")) {
      return { ok: true, status: 200, headers: new Headers({ "x-goog-upload-url": "https://gemini.test/upload-target" }) };
    }
    if (url === "https://gemini.test/upload-target") {
      return { ok: true, json: async () => ({ file: { name: "files/abc", uri: "https://gemini.test/files/abc", mimeType: "audio/mp4", state: "PROCESSING" } }) };
    }
    if (url === "https://gemini.test/v1beta/files/abc" && (options.method || "GET") === "GET") {
      return { ok: true, json: async () => ({ name: "files/abc", uri: "https://gemini.test/files/abc", mimeType: "audio/mp4", state: "ACTIVE" }) };
    }
    if (url.includes(":generateContent")) {
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Говорител 1: Здравейте." }] } }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const upload = parseMeetingUpload({ bytes: audio, mimeType: "audio/mp4", name: "a.m4a" });
  const result = await transcribeMeeting(upload, { env, fetchImpl });
  assert.equal(result.text, "Говорител 1: Здравейте.");
  assert.equal(calls[0].headers["X-Goog-Upload-Header-Content-Type"], "audio/mp4");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/files/abc")));
});

test("when Gemini fails, OpenAI speech-to-text reads the recording", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("api.openai.com")) return { ok: true, json: async () => ({ text: "Текст от OpenAI." }) };
    return { ok: false, status: 500, headers: new Headers() };
  };
  const upload = parseMeetingUpload({ bytes: audio, mimeType: "audio/mpeg", name: "a.mp3" });
  const result = await transcribeMeeting(upload, { env: { ...env, OPENAI_API_KEY: "o" }, fetchImpl });
  assert.equal(result.provider, "openai");
  assert.equal(result.text, "Текст от OpenAI.");
});

test("the summary keeps only clean lists and falls back to text", () => {
  const notes = parseMeetingSummary('{"title":"Бюджет","summary":"Говорихме.","decisions":["Да"],"tasks":["Иван: оферта", "", 5]}');
  assert.deepEqual(notes.tasks, ["Иван: оферта", "5"]);
  assert.match(formatMeetingNotes(notes), /## Бюджет[\s\S]*\*\*Решения:\*\*[\s\S]*- Иван: оферта/u);
  assert.equal(parseMeetingSummary("просто текст").summary, "просто текст");
});

test("silence is reported instead of an empty summary", async () => {
  await assert.rejects(
    () => processMeetingRecording(
      { bytes: audio, mimeType: "audio/wav", name: "x.wav" },
      { env, transcribe: async () => ({ text: "" }) },
    ),
    /не се чува реч/u,
  );
});

test("the handler returns the summary and tasks, keeps the text in files and saves the turn", async () => {
  const saved = [];
  const added = [];
  const handler = createMeetingNotesHandler({
    process: async () => ({ title: "Бюджет", summary: "Говорихме.", decisions: [], tasks: ["Иван: оферта"], transcript: "дума", name: "a.m4a" }),
    saveTurn: async (...args) => saved.push(args),
    files: () => ({ add: async (owner, file) => added.push({ owner, file }) }),
  });
  const headers = { "x-session-id": "s-1", "x-file-name": encodeURIComponent("a.m4a"), "content-type": "audio/mp4" };
  const req = { get: (name) => headers[name.toLowerCase()], body: audio, owner: { memoryOwnerId: "o1" } };
  let status = 200;
  let body;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await handler(req, res);
  assert.equal(status, 200);
  assert.deepEqual(body.tasks, ["Иван: оферта"]);
  assert.equal(body.savedToFiles, true);
  assert.match(added[0].file.text, /Текст на записа:\nдума/u);
  assert.equal(saved[0][0], "s-1");
  assert.equal(saved[0][3], "o1");
});
