import test from "node:test";
import assert from "node:assert/strict";

import { askWithFallback } from "../src/services/mcpAgentConversationService.js";

const env = { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" };

test("when the agent's provider fails, the site default answers", async () => {
  const calls = [];
  const askAi = async (request) => {
    calls.push([request.provider, request.model]);
    if (request.provider === "claude") throw new Error("503");
    return "отговор";
  };
  const text = await askWithFallback(askAi, { provider: "claude", model: "claude-haiku-5-5", input: [] }, env);
  assert.equal(text, "отговор");
  assert.deepEqual(calls, [["claude", "claude-haiku-5-5"], ["gemini", undefined]]);
});

test("no second try when the default itself failed or is not configured", async () => {
  const fail = async () => {
    throw new Error("down");
  };
  await assert.rejects(askWithFallback(fail, { provider: "claude", input: [] }, env), /down/u);
  await assert.rejects(askWithFallback(fail, { provider: "gemini", input: [] }, { GEMINI_API_KEY: "g" }), /down/u);
});
