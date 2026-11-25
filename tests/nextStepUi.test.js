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
  assert.match(chatRoute, /При поздрав, кратък въпрос или разговор не добавяй такъв ред/u);
  assert.match(chatRoute, /Никога не измисляй кодове, номера/u);
});

test("свободен текст от модела не се записва сам в Дневника", () => {
  assert.match(app, /fromStructuredResult/u);
  assert.match(app, /Добави в Дневника/u);
  assert.doesNotMatch(app, /Продължи с една конкретна задача по този отговор/u);
});

test("Council без собствен nextSteps показва конкретното защитено действие", () => {
  assert.match(app, /result\?\.mode === "council"/u);
  assert.match(app, /натисни „Изпълни препоръката“/u);
});

test("a failed sign-in offers registration with the same email", () => {
  assert.match(app, /error\.code === "AUTH_INVALID_CREDENTIALS" && state\.registrationEnabled/u);
  assert.match(app, /Създай профил с този имейл/u);
  assert.match(app, /най-вероятно още нямаш профил/u);
});
