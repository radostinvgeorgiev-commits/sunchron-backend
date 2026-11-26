import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../public/workspace-refresh.js", import.meta.url),
  "utf8",
);
function setup() {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://example.test",
  });
  const { window: w } = dom;
  w.confirm = () => false;
  w.alert = () => {};
  w.eval(script);
  return { w, d: w.document, close: () => w.close() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
test("starter only fills the composer and preserves an existing draft on refusal", () => {
  const { w, d, close } = setup();
  let sends = 0;
  d.getElementById("sendBtn").addEventListener("click", () => sends++);
  const input = d.getElementById("chatInput");
  const starter = d.querySelector("[data-starter]");
  starter.click();
  assert.match(input.value, /приоритетите/);
  assert.equal(sends, 0);
  input.value = "Моята чернова";
  starter.click();
  assert.equal(input.value, "Моята чернова");
  w.confirm = () => true;
  starter.click();
  assert.notEqual(input.value, "Моята чернова");
  input.disabled = true;
  input.value = "Запази";
  starter.click();
  assert.equal(input.value, "Запази");
  close();
});
test("search finds literal text, cycles matches and clears highlights on close", async () => {
  const { d, close } = setup();
  const messages = d.getElementById("chatMessages");
  for (const text of [
    "Отчет Варна",
    "ВАРНА <img onerror=alert(1)>",
    "Друг текст",
  ]) {
    const turn = d.createElement("div");
    turn.className = "user-turn";
    const message = d.createElement("div");
    message.className = "message user";
    message.dataset.rawText = text;
    message.textContent = text;
    turn.append(message);
    messages.append(turn);
  }
  await tick();
  assert.equal(d.getElementById("quickStart").hidden, true);
  d.getElementById("conversationFindBtn").click();
  const query = d.getElementById("conversationQuery");
  query.value = "варна";
  query.dispatchEvent(new d.defaultView.Event("input"));
  d.getElementById("conversationFindNext").click();
  await tick();
  assert.equal(d.querySelectorAll(".conversation-match").length, 1);
  assert.equal(d.getElementById("conversationFindCount").textContent, "1 от 2");
  d.getElementById("conversationFindNext").click();
  assert.equal(d.getElementById("conversationFindCount").textContent, "2 от 2");
  query.value = "<img";
  query.dispatchEvent(new d.defaultView.Event("input"));
  assert.equal(
    d.getElementById("conversationFindCount").textContent,
    "Намерени съобщения: 1",
  );
  assert.equal(messages.querySelectorAll("img").length, 0);
  d.getElementById("conversationFindClose").click();
  assert.equal(d.querySelectorAll(".conversation-match").length, 0);
  messages.replaceChildren();
  await tick();
  assert.equal(d.getElementById("quickStart").hidden, false);
  close();
});
test("export requires consent, excludes welcome and never exports another conversation", async () => {
  const { w, d, close } = setup();
  let created = 0,
    downloaded = 0,
    blob;
  w.URL.createObjectURL = (value) => {
    created++;
    blob = value;
    return "blob:test";
  };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {
    downloaded++;
    assert.match(this.download, /ai-core-razgovor/);
  };
  const messages = d.getElementById("chatMessages");
  messages.innerHTML =
    '<div class="assistant-turn welcome-turn"><div class="message agent">Welcome</div></div><div class="user-turn"><div class="message user">Текущ разговор</div></div>';
  d.getElementById("conversationExportBtn").click();
  assert.equal(created, 0);
  w.confirm = () => true;
  d.getElementById("conversationExportBtn").click();
  assert.equal(created, 1);
  assert.equal(downloaded, 1);
  assert.equal(blob.type, "text/markdown;charset=utf-8");
  const exported = await new Promise((resolve, reject) => {
    const reader = new w.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  assert.match(exported, /Текущ разговор/);
  assert.doesNotMatch(exported, /Welcome/);
  messages.replaceChildren();
  const next = d.createElement("div");
  next.className = "user-turn";
  next.innerHTML = '<div class="message user">Втори разговор</div>';
  messages.append(next);
  d.getElementById("conversationExportBtn").click();
  const nextExport = await new Promise((resolve) => {
    const reader = new w.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  assert.match(nextExport, /Втори разговор/);
  assert.doesNotMatch(nextExport, /Текущ разговор/);
  d.getElementById("chatInput").disabled = true;
  d.getElementById("conversationExportBtn").click();
  assert.equal(created, 2);
  close();
});
