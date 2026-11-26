import assert from "node:assert/strict";
import test from "node:test";
import { analyzeImage, validateImageInput } from "../src/services/imageService.js";

const pdf = { dataUrl: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf", name: "a.pdf" };

test("PDF documents are accepted as attachments", () => {
  assert.equal(validateImageInput(pdf).mimeType, "application/pdf");
  assert.throws(
    () => validateImageInput({ dataUrl: "data:text/plain;base64,aGk=", mimeType: "text/plain" }),
    { code: "UNSUPPORTED_IMAGE" },
  );
});

test("a PDF is sent to Claude as a document block", async () => {
  let sent;
  const text = await analyzeImage({
    image: pdf,
    prompt: "Обобщи",
    context: "rules",
    claudeAccessKey: "k",
    claudeModel: "claude-haiku-5-5",
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(
        JSON.stringify({ model: "claude-haiku-5-5", content: [{ type: "text", text: "Резюме." }], usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200 },
      );
    },
  });
  assert.equal(text, "Резюме.");
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.headers["x-api-key"], "k");
  assert.equal(sent.body.system, "rules");
  assert.deepEqual(sent.body.messages[0].content[0], {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
  });
});

test("without a Claude key a PDF is refused clearly instead of sent to OpenAI vision", async () => {
  await assert.rejects(
    analyzeImage({ image: pdf, prompt: "x", claudeAccessKey: "", modelAccessKey: "o", fetchImpl: async () => assert.fail("no call") }),
    { code: "DOCUMENT_READER_NOT_CONFIGURED" },
  );
});
