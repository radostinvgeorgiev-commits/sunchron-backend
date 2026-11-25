import assert from "node:assert/strict";
import test from "node:test";
import {
  probeAiProviders,
  resetAiProviderProbeCache,
} from "../src/services/aiProviderProbeService.js";

test("a key alone is not 'working': each provider gets one real request", async () => {
  resetAiProviderProbeCache();
  const calls = [];
  const results = await probeAiProviders({
    force: true,
    env: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "k", ANTHROPIC_API_KEY: "k" },
    request: async ({ provider }) => {
      calls.push(provider);
      if (provider === "gemini") throw Object.assign(new Error("x"), { status: 404 });
      if (provider === "claude") throw Object.assign(new Error("x"), { status: 400 });
      return { model: `${provider}-model` };
    },
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual(calls.sort(), ["claude", "gemini", "openai"]);
  assert.equal(byId.openai.working, true);
  assert.equal(byId.gemini.reason, "моделът не съществува");
  assert.match(byId.claude.reason, /кредит/u);
  assert.equal(byId.grok.configured, false);
});

test("probe results are cached for ten minutes", async () => {
  resetAiProviderProbeCache();
  let calls = 0;
  const options = {
    env: { OPENAI_API_KEY: "k" },
    request: async () => {
      calls += 1;
      return { model: "m" };
    },
  };
  let clock = 0;
  await probeAiProviders({ ...options, now: () => clock });
  clock = 9 * 60 * 1000;
  await probeAiProviders({ ...options, now: () => clock });
  assert.equal(calls, 1);
  clock = 11 * 60 * 1000;
  await probeAiProviders({ ...options, now: () => clock });
  assert.equal(calls, 2);
});
