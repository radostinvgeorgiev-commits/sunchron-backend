import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDriveFile,
  createSession,
  downloadDriveFile,
  listDriveFiles,
} from "../src/services/googleDriveService.js";

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("lists all supported Drive file types", async () => {
  const sessionId = createSession({ access_token: "token", expires_in: 3600 });
  let requestedUrl = "";
  const files = await listDriveFiles(sessionId, async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ files: [{ id: "one", name: "Test", mimeType: "application/pdf" }] });
  });
  assert.equal(files.length, 1);
  const query = new URL(requestedUrl).searchParams.get("q");
  assert.match(query, /application\/pdf/);
  assert.match(query, /vnd\.google-apps\.document/);
  assert.match(query, /wordprocessingml\.document/);
  assert.match(query, /spreadsheetml\.sheet/);
  assert.match(query, /image\/jpeg/);
});

test("exports Google Docs as PDF before analysis", async () => {
  const sessionId = createSession({ access_token: "token", expires_in: 3600 });
  const urls = [];
  const file = await downloadDriveFile(sessionId, "valid_id", async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return jsonResponse({
        id: "valid_id",
        name: "Документ",
        mimeType: "application/vnd.google-apps.document",
      });
    }
    return new Response(Buffer.from("pdf-data"), { status: 200 });
  });
  assert.equal(file.name, "Документ.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.match(urls[1], /\/export\?mimeType=application%2Fpdf/);
});

test("exports Google Sheets as CSV before analysis", async () => {
  const sessionId = createSession({ access_token: "token", expires_in: 3600 });
  const urls = [];
  const file = await downloadDriveFile(sessionId, "sheet_id", async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return jsonResponse({
        id: "sheet_id",
        name: "Таблица",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
    }
    return new Response("Име,Сума\nТест,10", { status: 200 });
  });
  assert.equal(file.name, "Таблица.csv");
  assert.equal(file.mimeType, "text/csv");
  assert.match(urls[1], /\/export\?mimeType=text%2Fcsv/);
});

test("sends images to OpenAI as vision input", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody;
  const analysis = await analyzeDriveFile({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("image"),
    prompt: "",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ output_text: "Виждам снимка." });
    },
  });
  assert.equal(analysis, "Виждам снимка.");
  assert.equal(requestBody.input[0].content[0].type, "input_image");
  assert.match(requestBody.input[0].content[0].image_url, /^data:image\/jpeg;base64,/);
});
