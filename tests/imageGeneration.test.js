import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cleanImagePrompt, createImageGenerationService } from "../src/services/imageGenerationService.js";

const VERTEX_ENV = Object.freeze({
  VERTEX_AI_ENABLED: "true",
  VERTEX_AI_PROJECT_ID: "project-123",
  VERTEX_AI_LOCATION: "global",
  VERTEX_AI_MODEL: "gemini-2.5-flash",
});
const authClient = { getRequestHeaders: async () => ({ Authorization: "Bearer test" }) };

test("a picture is drawn from the description through Vertex, small and charged first", async () => {
  const order = [];
  let sent;
  const service = createImageGenerationService({
    env: VERTEX_ENV,
    authClient,
    reserve: async (provider, model) => order.push(`reserve ${provider} ${model}`),
    fetchImpl: async (url, options) => {
      order.push("draw");
      assert.match(url, /aiplatform\.googleapis\.com/u);
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
  assert.deepEqual(order, ["reserve vertex-gemini gemini-2.5-flash-image-preview", "draw"]);
  assert.match(sent.contents[0].parts[0].text, /котка на луната/u);
  assert.equal(result.image, "data:image/png;base64,QUJD");
});

test("empty descriptions and missing Vertex configuration get clear messages", async () => {
  assert.throws(() => cleanImagePrompt(" "), { code: "IMAGE_PROMPT_EMPTY" });
  await assert.rejects(
    () => createImageGenerationService({
      env: { OPENAI_API_KEY: "k" },
    }).generate("нещо"),
    { code: "IMAGE_NOT_CONFIGURED" },
  );
  await assert.rejects(() => createImageGenerationService({ env: {} }).generate("котка"), { code: "IMAGE_NOT_CONFIGURED" });
});

test("drawing is open to every account and goes through the members' budget", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /"\/api\/images",\s*requireOwnerSession,\s*paidAiRateLimiter,\s*createImageGenerationRouter/u);
  assert.match(read("../src/routes/imageGenerationRouter.js"), /router\.post\("\/", publicAiBudgetContext/u);
  assert.match(read("../src/services/publicAiBudget.js"), /PUBLIC_IMAGE_CREDITS = 2/u);
});
