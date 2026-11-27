import test from "node:test";
import assert from "node:assert/strict";
import {
  requestClaudeResponse,
  requestGeminiResponse,
  requestGrokResponse,
  requestOpenAIResponse,
} from "../src/services/novariumService.js";
import { withTruncationNote } from "../src/routes/chat.js";

// A member's answer has a length cap; when a model stops there the person is
// told so instead of reading a sentence that just ends.
test("each model marks an answer that hit the length cap", async () => {
  const cases = [
    [requestOpenAIResponse, { output_text: "Част", incomplete_details: { reason: "max_output_tokens" } }],
    [requestGeminiResponse, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "Част" }] } }] }],
    [requestGrokResponse, { choices: [{ finish_reason: "length", message: { content: "Част" } }] }],
    [requestClaudeResponse, { stop_reason: "max_tokens", content: [{ type: "text", text: "Част" }] }],
  ];
  for (const [invoke, payload] of cases) {
    const result = await invoke({
      apiKey: "test",
      input: [{ role: "user", content: "Здравей" }],
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    assert.equal(result.truncated, true);
  }
  const whole = await requestClaudeResponse({
    apiKey: "test",
    input: [{ role: "user", content: "Здравей" }],
    fetchImpl: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Цял" }] }) }),
  });
  assert.equal(whole.truncated, undefined);
});

test("a cut answer ends with a note to ask for the rest", () => {
  assert.equal(withTruncationNote({ text: "Цял отговор." }), "Цял отговор.");
  const cut = withTruncationNote({ text: "Първа част ", truncated: true });
  assert.match(cut, /^Първа част…/u);
  assert.match(cut, /Напиши „продължи“/u);
  assert.match(withTruncationNote({ text: "Part", truncated: true }, "en"), /continue/u);
});
