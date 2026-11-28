import assert from "node:assert/strict";
import test from "node:test";
import {
  probeAiProviders,
  resetAiProviderProbeCache,
} from "../src/services/aiProviderProbeService.js";

test("Vertex readiness requires valid Google Cloud configuration and a successful probe", async () => {
  resetAiProviderProbeCache();
  const calls = [];
  const results = await probeAiProviders({
    force: true,
    env: {
      VERTEX_AI_ENABLED: "true",
      VERTEX_AI_PROJECT_ID: "novarium-test-12345",
      VERTEX_AI_LOCATION: "us-central1",
      VERTEX_AI_MODEL: "gemini-2.5-flash",
    },
    request: async ({ provider }) => {
      calls.push(provider);
      throw Object.assign(new Error("x"), { status: 503 });
    },
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual(calls, ["vertex-gemini"]);
  assert.equal(byId["vertex-gemini"].configured, true);
  assert.equal(byId["vertex-gemini"].working, false);
  assert.equal(byId["vertex-gemini"].reason, "претоварен");
});

test("probe results are cached for ten minutes", async () => {
  resetAiProviderProbeCache();
  let calls = 0;
  const options = {
    env: {
      VERTEX_AI_ENABLED: "true",
      VERTEX_AI_PROJECT_ID: "novarium-test-12345",
      VERTEX_AI_LOCATION: "us-central1",
      VERTEX_AI_MODEL: "gemini-2.5-flash",
    },
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
