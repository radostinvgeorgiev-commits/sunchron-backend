import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, styles, chatRoute] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/routes/chat.js", import.meta.url), "utf8"),
]);

test("всеки завършен AI отговор показва една следваща стъпка", () => {
  assert.match(app, /function showNextStep\(/u);
  assert.match(app, /showNextStep\(responseBubble, fullText, parsed\.data\)/u);
  assert.match(app, /Следва/u);
  assert.match(styles, /\.next-step-card/u);
});

test("следващата стъпка се свързва с Дневника на задачите", () => {
  assert.match(app, /SynchronTaskJournal\?\.setNextStep/u);
  assert.match(app, /SynchronTaskJournal\?\.openCurrentNext/u);
  assert.match(app, /Отвори в Дневника/u);
});

test("AI CORE формулира конкретната стъпка в машинно разпознаваем ред", () => {
  assert.match(chatRoute, /Следва: конкретна стъпка/u);
  assert.match(chatRoute, /изпълнима и пряко свързана с отговора/u);
});
