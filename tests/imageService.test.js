import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeImage,
  ImageServiceError,
  validateImageInput,
} from "../src/services/imageService.js";

const tinyPng = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mimeType: "image/png",
  name: "test.png",
};

test("image input validates supported base64 data URLs", () => {
  const result = validateImageInput(tinyPng);
  assert.equal(result.mimeType, "image/png");
  assert.ok(result.byteLength > 0);
});

test("image input rejects unsupported formats", () => {
  assert.throws(
    () =>
      validateImageInput({
        dataUrl: "data:image/gif;base64,R0lGODlh",
        mimeType: "image/gif",
      }),
    (error) =>
      error instanceof ImageServiceError &&
      error.code === "UNSUPPORTED_IMAGE",
  );
});

test("vision uses the existing DigitalOcean agent with text, context, and image", async () => {
  let request;
  const answer = await analyzeImage({
    image: tinyPng,
    prompt: "Какво виждаш?",
    context: "Отговаряй на български.",
    agentUrl: "https://example.agents.do-ai.run/",
    agentKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Виждам тестова снимка." } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(answer, "Виждам тестова снимка.");
  assert.equal(
    request.url,
    "https://example.agents.do-ai.run/api/v1/chat/completions",
  );
  assert.equal(request.options.headers.Authorization, "Bearer test-key");

  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[0].type, "text");
  assert.match(body.messages[0].content[0].text, /Отговаряй на български/u);
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.equal(body.messages[0].content[1].image_url.url, tinyPng.dataUrl);
});
