import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeImage } from "../src/services/imageService.js";
import { createPublicAiBudgetContext, PUBLIC_FILE_CREDITS } from "../src/services/publicAiBudget.js";

test("a member's picture or PDF is charged once at the file price", async () => {
  const reserved = [];
  const middleware = createPublicAiBudgetContext({
    reserve: async (_identity, credits, details) => reserved.push({ credits, ...details }),
  });
  let maxTokens;
  await new Promise((resolve, reject) => {
    middleware({ owner: { role: "member", id: "m1" } }, {}, () => {
      analyzeImage({
        image: { dataUrl: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf" },
        prompt: "Обобщи",
        geminiAccessKey: "",
        claudeAccessKey: "k",
        claudeModel: "claude-haiku-5-5",
        fetchImpl: async (_url, init) => {
          maxTokens = JSON.parse(init.body).max_tokens;
          return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
        },
      }).then(resolve, reject);
    });
  });
  assert.deepEqual(reserved, [{ credits: PUBLIC_FILE_CREDITS, provider: "claude", model: "claude-haiku-5-5" }]);
  assert.equal(maxTokens, 1024);
});

test("members can attach files; the attach button is no longer owner-only", () => {
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(chat, /TESTER_TOOL_DISABLED/u);
  assert.match(chat, /image\s*\?\s*PUBLIC_FILE_CREDITS\s*:\s*PUBLIC_REQUEST_CREDITS/u);
  assert.doesNotMatch(html, /class="attach-btn"\s+type="button"\s+data-owner-only/u);
});
