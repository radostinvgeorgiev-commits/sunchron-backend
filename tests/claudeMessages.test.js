import assert from "node:assert/strict";
import test from "node:test";
import { requestClaudeResponse, toClaudeMessages } from "../src/services/novariumService.js";

test("Claude messages start and end with the user and never repeat a role", () => {
  assert.deepEqual(
    toClaudeMessages([
      { role: "system", content: "rules" },
      { role: "assistant", content: "welcome" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "c" },
      { role: "assistant", content: "prefill" },
    ]),
    [
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "c" },
    ],
  );
});

test("a Claude 400 is logged with Anthropic's error type and message, never the key", async () => {
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    await assert.rejects(
      requestClaudeResponse({
        apiKey: "sk-ant-api03-secret",
        input: [{ role: "user", content: "hi" }],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "bad model sk-ant-api03-secret" },
            }),
            { status: 400 },
          ),
      }),
      { code: "CLAUDE_UPSTREAM_ERROR" },
    );
  } finally {
    console.error = original;
  }
  assert.match(logged[0], /400 invalid_request_error: bad model \[key\]/u);
  assert.doesNotMatch(logged.join("\n"), /secret/u);
});
