import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cleanImagePrompt, createImageGenerationService } from "../src/services/imageGenerationService.js";

test("a picture is drawn from the description, small and charged first", async () => {
  const order = [];
  let sent;
  const service = createImageGenerationService({
    env: { GEMINI_API_KEY: "g", GEMINI_API_URL: "https://gemini.test/v1beta" },
    reserve: async (provider, model) => order.push(`reserve ${provider} ${model}`),
    fetchImpl: async (url, options) => {
      order.push("draw");
      assert.match(url, /gemini\.test\/v1beta\/models\//u);
      sent = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { data: "QUJD" } }] } }],
        }),
      };
    },
  });
  const result = await service.generate("  котка\nна луната ");
  assert.deepEqual(order, ["reserve gemini gemini-2.5-flash-image-preview", "draw"]);
  assert.match(sent.contents[0].parts[0].text, /котка на луната/u);
  assert.equal(result.image, "data:image/png;base64,QUJD");
});

test("empty descriptions, fallback and missing keys get clear messages", async () => {
  assert.throws(() => cleanImagePrompt(" "), { code: "IMAGE_PROMPT_EMPTY" });
  const fallback = createImageGenerationService({
    env: { GEMINI_API_KEY: "g", OPENAI_API_KEY: "k" },
    reserve: async () => {},
    fetchImpl: async (url) =>
      url.includes("generativelanguage")
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) },
  });
  const fallbackResult = await fallback.generate("нещо");
  assert.equal(fallbackResult.image, "data:image/webp;base64,QUJD");

  const refused = createImageGenerationService({
    env: { OPENAI_API_KEY: "k" },
    reserve: async () => {},
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: "moderation_blocked" } }) }),
  });
  await assert.rejects(() => refused.generate("нещо"), { code: "IMAGE_REFUSED" });
  await assert.rejects(() => createImageGenerationService({ env: {} }).generate("котка"), { code: "IMAGE_NOT_CONFIGURED" });
});

test("drawing is open to every account and goes through the members' budget", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /"\/api\/images",\s*requireOwnerSession,\s*paidAiRateLimiter,\s*createImageGenerationRouter/u);
  assert.match(read("../src/routes/imageGenerationRouter.js"), /router\.post\("\/", publicAiBudgetContext/u);
  assert.match(read("../src/services/publicAiBudget.js"), /PUBLIC_IMAGE_CREDITS = 2/u);
});
