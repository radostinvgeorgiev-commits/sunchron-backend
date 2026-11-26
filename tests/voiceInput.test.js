import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("the site allows its own microphone for voice input and nothing else", () => {
  assert.match(server, /microphone=\(self\)/u);
  assert.doesNotMatch(server, /microphone=\(\)/u);
  assert.match(server, /camera=\(\)/u);
});

test("voice errors explain what to do", () => {
  assert.match(app, /"not-allowed": "Микрофонът е забранен за сайта/u);
  assert.match(app, /"service-not-allowed": "Разпознаването на говор е изключено/u);
  assert.match(app, /state\.recognition\.abort\(\)/u);
});
