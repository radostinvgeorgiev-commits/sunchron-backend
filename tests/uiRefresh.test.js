import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const html = read("index.html");

test("header is quiet: language in the profile menu, a new-chat button for phones", () => {
  const header = html.slice(html.indexOf('<header class="chat-toolbar">'), html.indexOf("</header>", html.indexOf('<header class="chat-toolbar">')));
  assert.doesNotMatch(header, /data-language-switch/u);
  assert.match(header, /id="mobileNewChatBtn"/u);
  assert.match(html, /class="profile-language"[\s\S]*?data-language-switch/u);
});

test("composer: microphone icon, '+' menu with file and Council", () => {
  assert.match(html, /id="voiceBtn"[\s\S]*?fa-microphone/u);
  const js = read("ui-refresh.js");
  assert.match(js, /data-plus="file"/u);
  assert.match(js, /data-plus="council"/u);
  assert.match(js, /\$\("imageInput"\)\?\.click\(\)/u);
});

test("Council defaults to Claude and Gemini", () => {
  const picker = html.slice(html.indexOf('id="councilProviderPicker"'), html.indexOf("</fieldset>", html.indexOf('id="councilProviderPicker"')));
  const checked = [...picker.matchAll(/value="(\w+)"\s*(checked)?/gu)].filter((m) => m[2]).map((m) => m[1]);
  assert.deepEqual(checked.sort(), ["claude", "gemini"]);
});

test("ui-refresh loads after every other stylesheet", () => {
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/gu)].map((m) => m[1]);
  assert.equal(links.at(-1), "/ui-refresh.css");
});

test("the side menu has the person's own things and the + menu stays short", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../public/ui-refresh.js", import.meta.url), "utf8");
  assert.match(js, /mine-group/u);
  assert.match(js, /data-plus="models"/u);
  const menu = js.slice(js.indexOf("menu.innerHTML"), js.indexOf("composer.prepend(menu)"));
  assert.doesNotMatch(menu, /data-plus="(avatar|day|google|causes)"/u);
});
