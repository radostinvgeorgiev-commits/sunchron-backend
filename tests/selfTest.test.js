import test from "node:test";
import assert from "node:assert/strict";

import {
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
  const pdf = tinyPdf("AI CORE TEST 1234");
  assert.match(pdf.toString("latin1"), /^%PDF-1\.4[\s\S]*%%EOF\n$/u);
  validateImageInput({
    dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    mimeType: "application/pdf",
  });
});

test("all checks pass, Grok without a key is skipped, nothing secret is returned", async () => {
  const report = await runSelfTest({
    env,
    askAi: async ({ input }) => `Числото е ${echoMarker(input[0].content)}.`,
    transcribe: async () => ({ text: "", provider: "openai" }),
    readDocument: async ({ image }) =>
      echoMarker(Buffer.from(image.dataUrl.split(",")[1], "base64").toString("latin1")),
    shareService: memoryShare(),
    knowledgeService: memoryKnowledge(),
    libraryService: memoryLibrary(),
    avatarProfileService: memoryAvatar(),
  });
  assert.equal(report.status, "pass");
  assert.equal(report.failed, 0);
  assert.equal(report.checks.find(({ name }) => name === "Чат · grok").status, "skipped");
  assert.equal(report.checks.length, 11);
  assert.match(formatSelfTest(report), /10 минаха, 0 не минаха, 1 пропуснати/u);
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
    readDocument: async () => "нищо",
    shareService: memoryShare(),
    knowledgeService: memoryKnowledge(),
    libraryService: memoryLibrary(),
    avatarProfileService: memoryAvatar(),
  });
  assert.equal(report.status, "fail");
  assert.equal(report.checks.find(({ name }) => name === "Чат · gemini").detail, "GEMINI_UPSTREAM_ERROR");
  assert.equal(report.checks.find(({ name }) => name.startsWith("PDF")).status, "fail");
});

test("the MCP tool runs the self-test for the verified owner", async () => {
  assert.ok(MCP_CAPABILITY_TOOLS.some(({ name }) => name === "run_ai_core_self_test"));
  const handler = createMcpCapabilityHandler({
    audit: async () => {},
    dependencies: {
      runSelfTest: async () => ({ status: "pass", passed: 1, failed: 0, skipped: 0, checks: [], notCovered: [] }),
    },
  });
  const { result } = await handler("run_ai_core_self_test", {}, { ownerId: "owner" });
  assert.equal(result.structuredContent.status, "pass");
  assert.match(result.content[0].text, /Самопроверка: 1 минаха/u);
});
