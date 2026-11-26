import assert from "node:assert/strict";
import test from "node:test";

import { providerFailureSummary } from "../src/services/aiCouncilService.js";
import {
  AiCoreError,
  requestOpenAIResponse,
  supportsOpenAIReasoning,
} from "../src/services/aiCoreService.js";

test("provider failures expose only provider, code and HTTP status", () => {
  assert.deepEqual(
    providerFailureSummary(
      "claude",
      new AiCoreError("Claude върна грешка 404.", "CLAUDE_UPSTREAM_ERROR", 404),
    ),
    { provider: "claude", code: "CLAUDE_UPSTREAM_ERROR", status: 404 },
  );
  assert.deepEqual(providerFailureSummary("grok", new Error("not_configured")), {
    provider: "grok",
    code: "NOT_CONFIGURED",
  });
  assert.deepEqual(
    providerFailureSummary("gemini", { code: "secret value with spaces", status: 99 }),
    { provider: "gemini", code: "UNKNOWN" },
  );
});

test("the reasoning parameter is sent only to reasoning models", async () => {
  assert.equal(supportsOpenAIReasoning("gpt-4.1-mini"), false);
  assert.equal(supportsOpenAIReasoning("gpt-5.6-terra"), true);
  assert.equal(supportsOpenAIReasoning("o4-mini"), true);
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ output_text: "здравей", model: "m" });
  };
  for (const model of ["gpt-4.1-mini", "gpt-5.6-terra"]) {
    await requestOpenAIResponse({
      apiKey: "test",
      model,
      input: [{ role: "user", content: "здравей" }],
      fetchImpl,
    });
  }
  assert.equal(bodies[0].reasoning, undefined);
  assert.deepEqual(bodies[1].reasoning, { effort: "none" });
});
