import test from "node:test";
import assert from "node:assert/strict";

import { checkCoreTools } from "../src/services/toolLiveCheckService.js";

const deps = (overrides = {}) => ({
  probe: async () => [
    { id: "claude", working: true },
    { id: "openai", working: false, reason: "лимит или няма кредит" },
    { id: "gemini", working: true },
    { id: "vertex-gemini", working: true },
  ],
  readiness: async () => ({ checks: { memory: { ready: true } } }),
  systemReport: async () => ({ summary: { missingRequired: 0 } }),
  cloudStatus: () => ({ status: "running" }),
  tasks: async () => [],
  ...overrides,
});

test("each tool is green only when its own real check answered", async () => {
  const tools = await checkCoreTools({ ownerId: "o" }, deps());
  assert.deepEqual(tools["synchron-agent-chat"], { ok: true });
  assert.deepEqual(tools["openai-codex"], { ok: true });
  assert.deepEqual(tools["gemini-maps"], { ok: true });
  assert.deepEqual(tools["google-firestore-memory"], { ok: true });
  assert.deepEqual(tools["synchron-tasks"], { ok: true });
  assert.deepEqual(tools["google-cloud-read"], { ok: true });
  assert.deepEqual(tools["openai-web-search"], { ok: true });
});

test("a failing or hanging check never turns green", async () => {
  const tools = await checkCoreTools({}, deps({
    probe: async () => { throw new Error("token=secret"); },
    readiness: async () => ({ checks: { memory: { ready: false } } }),
    systemReport: async () => ({ summary: { missingRequired: 2 } }),
    cloudStatus: () => ({ status: "unavailable" }),
    tasks: async () => { throw new Error("down"); },
  }));
  for (const result of Object.values(tools)) assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(tools), /secret/u);
});
