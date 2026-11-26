import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  answerTablesToCsv,
  answerToHtml,
  createSession,
  saveAnswerToGoogle,
} from "../src/services/googleDriveService.js";

const answer = "# План\n**Важно** <script>\n- едно\n\n| Име | Цена |\n|---|---|\n| Хляб | 2,5 |";

test("answers become safe HTML and tables become CSV", () => {
  const html = answerToHtml(answer);
  assert.match(html, /<h1>План<\/h1>/u);
  assert.match(html, /<b>Важно<\/b> &lt;script&gt;/u);
  assert.match(html, /<ul><li>едно<\/li><\/ul>/u);
  assert.match(html, /<th>Име<\/th>/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.equal(answerTablesToCsv(answer), 'Име,Цена\nХляб,"2,5"');
  assert.equal(answerTablesToCsv("без таблица"), "");
});

test("a doc is uploaded with conversion and returns its link", async () => {
  const id = await createSession({ access_token: "token", expires_in: 3600 });
  let call;
  const result = await saveAnswerToGoogle(id, { kind: "doc", title: "План", text: answer }, async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ id: "f1", name: "План", webViewLink: "https://docs.google.com/document/d/f1" }), { status: 200 });
  });
  assert.match(call.url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/u);
  assert.equal(call.options.method, "POST");
  assert.match(call.options.body, /"mimeType":"application\/vnd\.google-apps\.document"/u);
  assert.match(call.options.body, /Content-Type: text\/html/u);
  assert.deepEqual(result, { id: "f1", name: "План", url: "https://docs.google.com/document/d/f1", kind: "doc" });
});

test("a sheet needs a table and nothing empty is saved", async () => {
  const id = await createSession({ access_token: "token", expires_in: 3600 });
  const never = async () => assert.fail("no request");
  await assert.rejects(saveAnswerToGoogle(id, { kind: "sheet", text: "без таблица" }, never), { code: "GOOGLE_SAVE_NO_TABLE" });
  await assert.rejects(saveAnswerToGoogle(id, { kind: "doc", text: "  " }, never), { code: "GOOGLE_SAVE_INVALID" });
  await assert.rejects(saveAnswerToGoogle(id, { kind: "exe", text: "x" }, never), { code: "GOOGLE_SAVE_INVALID" });
  let body = "";
  await saveAnswerToGoogle(id, { kind: "sheet", text: answer }, async (_url, options) => {
    body = options.body;
    return new Response("{}", { status: 200 });
  });
  assert.match(body, /vnd\.google-apps\.spreadsheet/u);
  assert.match(body, /Content-Type: text\/csv/u);
});

test("every answer has a „Запази в Google“ button and the route exists", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const router = readFileSync(new URL("../src/routes/googleDriveRouter.js", import.meta.url), "utf8");
  assert.match(app, /data-action="save-google"/u);
  assert.match(app, /fetch\("\/api\/google\/save"/u);
  assert.match(router, /router\.post\("\/save"/u);
});
