import { randomUUID } from "node:crypto";

import { isAiProviderConfigured, requestAiText } from "./aiCoreService.js";
import { ASSISTANT_PRESETS } from "./assistantPresets.js";
import { analyzeImage } from "./imageService.js";
import { createShareService } from "./shareService.js";
import { createKnowledgeFilesService } from "./knowledgeFilesService.js";
import { createUserLibraryService } from "./userLibraryService.js";
import { buildAvatarProfileContext, createAvatarProfileService } from "./avatarProfileService.js";
import { transcribeVoice } from "./voiceTranscriptionService.js";
import { CHAT_MODEL_CHOICES, resolveWorkAgentProvider } from "./workModeService.js";

// A self-test the owner's connector can run instead of clicking through the
// site by hand. Every check is a real call (a few cents of AI use in total),
// touches only its own throwaway data and reports pass/fail with a plain
// reason. Secrets and answers' full text are never returned.
const CHAT_PROVIDERS = ["claude", "openai", "gemini", "grok"];
const CHECK_TIMEOUT_MS = 30_000;

// One second of silence, 8 kHz mono 16-bit: enough to prove the recording is
// accepted and a provider answers. It cannot prove recognition quality.
export function silentWav(seconds = 1, rate = 8000) {
  const data = Buffer.alloc(seconds * rate * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A one-page PDF with a single line of text.
export function tinyPdf(text) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "SELF_TEST_TIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await withTimeout(run());
    return { name, status: "pass", ms: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    if (error?.skip) return { name, status: "skipped", ms: 0, detail: error.message };
    return {
      name,
      status: "fail",
      ms: Date.now() - started,
      detail: String(error?.code || error?.message || "error").slice(0, 160),
    };
  }
}

const skip = (message) => Object.assign(new Error(message), { skip: true });

export async function runSelfTest({
  env = process.env,
  askAi = requestAiText,
  transcribe = transcribeVoice,
  readDocument = analyzeImage,
  shareService,
  knowledgeService,
  libraryService,
  avatarProfileService,
} = {}) {
  const marker = String(1000 + Math.floor(Math.random() * 9000));
  const chatChecks = CHAT_PROVIDERS.map((provider) =>
    check(`Чат · ${provider}`, async () => {
      if (!isAiProviderConfigured(provider, env)) throw skip("не е конфигуриран");
      const text = await askAi({
        provider,
        input: [{ role: "user", content: `Отговори само с числото ${marker}.` }],
        reasoningEffort: "low",
        verbosity: "low",
      });
      if (!String(text || "").includes(marker)) throw new Error("неочакван отговор");
      return "отговори вярно";
    }),
  );

  const voice = check("Глас · запис към текст", async () => {
    if (!env.OPENAI_API_KEY && !env.GEMINI_API_KEY) throw skip("няма ключ за разпознаване");
    const result = await transcribe(
      { audio: silentWav().toString("base64"), mimeType: "audio/wav", language: "bg" },
      { env },
    );
    return `приет от ${result.provider}; тестовият запис е тишина, затова качеството не се проверява`;
  });

  const pdf = check("PDF · четене на документ", async () => {
    if (!env.ANTHROPIC_API_KEY) throw skip("няма Claude ключ");
    const result = await readDocument({
      image: {
        dataUrl: `data:application/pdf;base64,${tinyPdf(`AI CORE TEST ${marker}`).toString("base64")}`,
        mimeType: "application/pdf",
        name: "self-test.pdf",
      },
      prompt: "Кое число е написано в документа? Отговори само с числото.",
    });
    const text = typeof result === "string" ? result : result?.text || result?.reply || "";
    if (!String(text).includes(marker)) throw new Error("числото не е прочетено");
    return "прочете текста";
  });

  const share = check("Споделяне · създай, отвори, спри", async () => {
    const ownerId = `self-test-${randomUUID()}`;
    const service =
      shareService ||
      createShareService({
        env,
        listMessages: async () => [
          { role: "user", content: `Тест ${marker}` },
          { role: "assistant", content: "Тестов отговор." },
        ],
      });
    const created = await service.create({ ownerId, sessionId: "self-test", title: "Самопроверка" });
    try {
      const shared = await service.read(created.token);
      if (shared?.messages?.length !== 2) throw new Error("линкът не връща съобщенията");
    } finally {
      await service.remove({ ownerId, sessionId: "self-test" });
    }
    if (await service.read(created.token)) throw new Error("линкът не спря");
    return "линкът се създава, чете и спира";
  });

  const knowledge = check("Моите файлове · добави, намери, изтрий", async () => {
    const ownerId = `self-test-${randomUUID()}`;
    const service = knowledgeService || createKnowledgeFilesService({ env });
    const file = await service.add(ownerId, {
      name: "self-test.txt",
      text: `Тестов файл.\n\nКодът на поръчката за самопроверка е ${marker}.`,
    });
    try {
      const found = await service.search(ownerId, "Какъв е кодът на поръчката за самопроверка?");
      if (!found.some(({ text }) => text.includes(marker))) throw new Error("откъсът не е намерен");
    } finally {
      await service.remove(ownerId, file.id);
    }
    return "файлът се добавя, търси и изтрива";
  });

  const library = check("Собствени асистенти и подсказки", async () => {
    const ownerId = `self-test-${randomUUID()}`;
    const service = libraryService || createUserLibraryService({ env });
    const saved = await service.save(ownerId, {
      assistants: [{ name: "Тест", instruction: `Отговаряй с ${marker}.` }],
    });
    try {
      const mine = await service.resolveAssistant(ownerId, `custom:${saved.assistants[0].id}`);
      if (!mine?.instruction.includes(marker)) throw new Error("асистентът не се зарежда");
    } finally {
      await service.save(ownerId, {});
    }
    return "записват се и се зареждат";
  });

  const avatar = check("Профил на аватара", async () => {
    const ownerId = `self-test-${randomUUID()}`;
    const service = avatarProfileService || createAvatarProfileService({ env });
    await service.save(ownerId, { about: `Тестов профил ${marker}.` });
    try {
      if (!buildAvatarProfileContext(await service.read(ownerId)).includes(marker)) {
        throw new Error("профилът не се зарежда");
      }
    } finally {
      await service.save(ownerId, {});
    }
    return "записва се, зарежда се и се изтрива";
  });

  const lists = check("Избор на модел и асистенти", async () => {
    const missing = CHAT_MODEL_CHOICES.slice(1).filter(({ id }) => !resolveWorkAgentProvider(id));
    if (missing.length || ASSISTANT_PRESETS.length < 5) throw new Error("непълен списък");
    return `${CHAT_MODEL_CHOICES.length - 1} модела, ${ASSISTANT_PRESETS.length} асистенти`;
  });

  const checks = await Promise.all([...chatChecks, voice, pdf, share, knowledge, library, avatar, lists]);
  const failed = checks.filter(({ status }) => status === "fail").length;
  return {
    status: failed ? "fail" : "pass",
    passed: checks.filter(({ status }) => status === "pass").length,
    failed,
    skipped: checks.filter(({ status }) => status === "skipped").length,
    checkedAt: new Date().toISOString(),
    checks,
    notCovered: [
      "бутоните на екрана",
      "вход с Google и с парола",
      "истински микрофон на телефон",
    ],
  };
}

export function formatSelfTest(result) {
  const icon = { pass: "✅", fail: "❌", skipped: "—" };
  return [
    `Самопроверка: ${result.passed} минаха, ${result.failed} не минаха, ${result.skipped} пропуснати.`,
    ...result.checks.map(
      ({ name, status, detail, ms }) =>
        `${icon[status]} ${name}${detail ? ` — ${detail}` : ""}${status === "skipped" ? "" : ` (${ms} ms)`}`,
    ),
    `Не се покрива: ${result.notCovered.join("; ")}.`,
  ].join("\n");
}
