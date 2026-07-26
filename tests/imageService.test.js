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

test("vision uses the Responses API with text, context, and image", async () => {
  let request;
  const answer = await analyzeImage({
    image: tinyPng,
    prompt: "Какво виждаш?",
    context: "Отговаряй на български.",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({ output_text: "Виждам тестова снимка." }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(answer, "Виждам тестова снимка.");
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");

  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.input[0].content[0].type, "input_text");
  assert.match(body.input[0].content[0].text, /Отговаряй на български/u);
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.equal(body.input[0].content[1].image_url, tinyPng.dataUrl);
});
