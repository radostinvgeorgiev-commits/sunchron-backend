import test from "node:test";
import assert from "node:assert/strict";

import {
  answerExcerpt,
  answerHasNumber,
  formatSelfTest,
  runSelfTest,
  silentWav,
  tinyPdf,
} from "../src/services/selfTestService.js";
import { parseAudioPayload } from "../src/services/voiceTranscriptionService.js";
import { validateImageInput } from "../src/services/imageService.js";
import { createMcpCapabilityHandler, MCP_CAPABILITY_TOOLS } from "../src/services/mcpCapabilityService.js";

const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" };

function memoryShare() {
  const store = new Map();
  return {
    async create({ ownerId }) {
      store.set("t", { messages: [1, 2] });
      store.set(`o:${ownerId}`, "t");
      return { token: "t" };
    },
    async read(token) {
      return store.get(token) || null;
    },
    async remove() {
      store.delete("t");
    },
  };
}

function memoryKnowledge() {
  let stored = "";
  return {
    async add(_owner, { text }) {
      stored = text;
      return { id: "f1" };
    },
    async search() {
      return stored ? [{ file: "self-test.txt", text: stored }] : [];
    },
    async remove() {
      stored = "";
    },
  };
}
function memoryLibrary() {
  let saved = {};
  return {
    async save(_owner, value) {
      saved = { assistants: (value.assistants || []).map((a) => ({ ...a, id: "aaaaaaaa-1111" })) };
      return saved;
    },
    async resolveAssistant() {
      return saved.assistants?.[0] ? { instruction: saved.assistants[0].instruction } : null;
    },
  };
}

function memoryAvatar() {
  let saved = {};
  return {
    async save(_owner, value) {
      saved = { ...value };
      return saved;
    },
    async read() {
      return saved;
    },
  };
}

const echoMarker = (content) => /\d{4}/u.exec(content)[0];

test("the built-in samples are accepted by the real validators", () => {
  assert.equal(parseAudioPayload({ audio: silentWav().toString("base64"), mimeType: "audio/wav" }).extension, "wav");
  const pdf = tinyPdf("NovariumAI TEST 1234");
  assert.match(pdf.toString("latin1"), /^%PDF-1\.4[\s\S]*%%EOF\n$/u);
  validateImageInput({
    dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    mimeType: "application/pdf",
  });
});

// "Работа с Claude" without the network: writes the number it was asked for.
function fakeClaudeWork() {
  const files = new Map();
  return {
    async run(ownerId, { task }) {
      const number = task.match(/\d{4}/u)[0];
      files.set(ownerId, number);
      return { text: "Готово.", files: [{ id: "f1", name: "self-test.txt" }], model: "claude-haiku-5-5" };
    },
    async download(ownerId) {
      return { body: Buffer.from(files.get(ownerId) || "") };
    },
    async clear(ownerId) {
      files.delete(ownerId);
    },
  };
}

test("all checks pass, Grok without a key is skipped, nothing secret is returned", async () => {
  const report = await runSelfTest({
    env,
    askAi: async ({ input }) => `Числото е ${echoMarker(input[0].content)}.`,
    transcribe: async () => ({ text: "", provider: "openai" }),
    readMeeting: async (upload) => {
      assert.equal(upload.type, "audio/wav");
      return { text: "", provider: "gemini" };
    },
    readDocument: async ({ image }) =>
      echoMarker(Buffer.from(image.dataUrl.split(",")[1], "base64").toString("latin1")),
    shareService: memoryShare(),
    knowledgeService: memoryKnowledge(),
    libraryService: memoryLibrary(),
    avatarProfileService: memoryAvatar(),
    claudeWorkService: fakeClaudeWork(),
  });
  assert.equal(report.checks.find(({ name }) => name.startsWith("Запис от среща")).detail, "Gemini прие и прочете записа");
  assert.equal(report.status, "pass");
  assert.equal(report.failed, 0);
  assert.equal(report.checks.find(({ name }) => name === "Чат · grok").status, "skipped");
  assert.equal(report.checks.find(({ name }) => name === "Чат · vertex-gemini").status, "skipped");
  assert.equal(report.checks.length, 15);
  assert.match(formatSelfTest(report), /12 минаха, 0 не минаха, 3 пропуснати/u);
  assert.match(report.checks.find(({ name }) => name.startsWith("Работа с Claude")).detail, /self-test\.txt/u);
  assert.doesNotMatch(JSON.stringify(report), /"a"|"o"|"g"/u);
});

test("a failing provider is reported as a failure with a short reason", async () => {
  const report = await runSelfTest({
    env,
    askAi: async ({ provider, input }) => {
      if (provider === "gemini") throw Object.assign(new Error("503"), { code: "GEMINI_UPSTREAM_ERROR" });
      return echoMarker(input[0].content);
    },
    transcribe: async () => ({ text: "", provider: "openai" }),
    readMeeting: async () => ({ text: "", provider: "gemini" }),
    readDocument: async () => "нищо",
    shareService: memoryShare(),
    knowledgeService: memoryKnowledge(),
    libraryService: memoryLibrary(),
    avatarProfileService: memoryAvatar(),
    claudeWorkService: fakeClaudeWork(),
  });
  assert.equal(report.status, "fail");
  assert.equal(report.checks.find(({ name }) => name === "Чат · gemini").detail, "GEMINI_UPSTREAM_ERROR");
  assert.equal(report.checks.find(({ name }) => name.startsWith("PDF")).status, "fail");
});

test("a number with grouped thousands is the right answer, another number is not", () => {
  for (const answer of ["4821", "Числото е 4821.", "4 821", "4,821", "4.821", "4\u00a0821", "4\u202f821", "4’821"]) {
    assert.equal(answerHasNumber(answer, "4821"), true, answer);
  }
  for (const answer of ["4,821.00", "4.821,00", "**4821**", "4821\n"]) {
    assert.equal(answerHasNumber(answer, "4821"), true, answer);
  }
  for (const answer of [
    "48.21",
    "482 1",
    "1234",
    "",
    null,
    "четири хиляди",
    "14821",
    "48210",
    "14 821",
    "34,821",
    "1,234,821",
    "4,821,000",
    "24.821",
    "4\n821",
    "4\t821",
  ]) {
    assert.equal(answerHasNumber(answer, "4821"), false, String(answer));
  }
  assert.equal(answerHasNumber("1 234 567", "1234567"), true);
});

test("an unexpected chat answer is shown on one short line", async () => {
  assert.equal(answerExcerpt("  Sorry,\n\nI can't   do that. "), "Sorry, I can't do that.");
  assert.equal(answerExcerpt(""), "празен отговор");
  const long = answerExcerpt("x".repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
  for (let at = 50; at < 62; at += 1) {
    const cut = answerExcerpt(`${"a".repeat(at)}😀${"b".repeat(20)}`);
    assert.ok(cut.isWellFormed(), `emoji at ${at}`);
    assert.ok(Array.from(cut).length <= 60);
  }
  assert.equal(answerExcerpt("c\u0000d\u001b[31m"), "c d [31m");

  const report = await runSelfTest({
    env: { ...env, GROK_API_KEY: "k" },
    askAi: async ({ provider, input }) => {
      const marker = echoMarker(input[0].content);
      if (provider === "grok") return "I cannot share numbers.";
      if (provider === "openai") return `${marker[0]} ${marker.slice(1)}`;
      return marker;
    },
    transcribe: async () => ({ text: "", provider: "openai" }),
    readMeeting: async () => ({ text: "", provider: "gemini" }),
    readDocument: async ({ image }) =>
      echoMarker(Buffer.from(image.dataUrl.split(",")[1], "base64").toString("latin1")),
    shareService: memoryShare(),
    knowledgeService: memoryKnowledge(),
    libraryService: memoryLibrary(),
    avatarProfileService: memoryAvatar(),
    claudeWorkService: fakeClaudeWork(),
  });
  const grok = report.checks.find(({ name }) => name === "Чат · grok");
  assert.equal(grok.status, "fail");
  assert.equal(grok.detail, "неочакван отговор: „I cannot share numbers.“");
  assert.equal(report.checks.find(({ name }) => name === "Чат · openai").status, "pass");
});

test("the MCP tool runs the self-test for the verified owner", async () => {
  assert.ok(MCP_CAPABILITY_TOOLS.some(({ name }) => name === "run_novarium_self_test"));
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    dependencies: {
      runSelfTest: async () => ({ status: "pass", passed: 1, failed: 0, skipped: 0, checks: [], notCovered: [] }),
    },
  });
  const { result } = await handler("run_novarium_self_test", {}, { ownerId: "owner" });
  assert.equal(result.structuredContent.status, "pass");
  assert.match(result.content[0].text, /Самопроверка: 1 минаха/u);
});
