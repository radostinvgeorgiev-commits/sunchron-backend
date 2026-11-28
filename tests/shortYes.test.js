import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { isShortYes, yesWithAddition } from "../src/services/shortYes.js";

// The fastest of three runs, so a busy machine does not fail a time check.
function fastest(run) {
  let best = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

test("a bare agreement is a short yes, in every page language", () => {
  for (const yes of [
    // The design's own examples, and the owner's capital letters (27.11).
    "ДА", "ДА ДАВАЙ", "да давай", "Да, направи ги", "ок давай", "добре, давай", "yes go ahead",
    "sure, go ahead", "yes do it", "Ja", "ja, bitte", "Oui", "Sí", "Sì", "Da", "ДА!!!",
    // Earlier short yeses keep working.
    "да", "Да.", "давай", "ок", "Окей", "добре!", "направи го", "продължи", "изпълни препоръката",
    "Изпълни препоръката.", "избери варианта", "хайде", "действай", "пускай", "става",
    "yes", "Yes!", "yeah", "yep", "yup", "sure", "ok", "OK", "okay", "go ahead", "Go ahead.", "do it",
    "please do", "continue", "go on", "proceed", "Да, продължи", "да, моля", "давай моля", "yes please",
    "Yes, please.", "yes, go ahead", "Yes, do it!", "да, благодаря",
    // Review r1: common agreements the lists missed.
    "Да, направи ги всички", "ДА ДАВАЙ НАПРАВИ ГИ ВСИЧКИТЕ", "Yes, make them", "make them", "Супер, давай",
    "Чудесно, давай", "Разбира се", "Може", "ДАВАЙ ПРАВИ ГИ", "Давай, направи ги всичките", "Да, направи и двете",
    "Go for it", "Sounds good", "Let's do it", "Absolutely", "yes, all of them", "Yes, both", "great, go ahead",
    "Los geht's", "Ja, danke", "Allez-y", "Oui, allez-y", "Oui merci", "Oui, s'il vous plaît", "Sí, gracias",
    "Sí, hazlas", "Vai pure", "Sì, grazie", "Da, mulțumesc", "是的", "可以",
    // Bulgarian typed in Latin letters.
    "DA DAVAI", "DAVAI", "davay", "hajde", "dobre", "deystvai",
    // The other page languages and the content languages.
    "Jawohl", "klar", "Gerne!", "mach los", "weiter", "Sí, por favor", "vale", "claro", "dale", "adelante",
    "hazlo", "Oui, s'il te plaît", "ouais", "d'accord", "vas-y", "allez", "fais-le", "Sì, per favore",
    "certo", "vai", "procedi", "fallo", "Da, te rog", "sigur", "bine", "hai", "fă-o", "так", "evet", "tamam",
    "好", "好的", "是", "行", "हाँ", "हां", "ہاں", "جی", "نعم",
    // Quotes, emoji and dashes are not words.
    "„да“", "\"yes\"", "да 👍", "ДА — давай", "yes!!! 🙂",
    // Review r5: the owner's six capital words, and agreements the lists
    // missed.
    "ДА ДАВАЙ НАПРАВИ ГИ ВСИЧКИТЕ СЕГА", "okey", "OKEY DAVAI", "Alright", "All right", "Sure thing",
    "Да, искам", "Да, точно така", "Точно така, давай", "hayde", "stava", "moje", "pravi gi", "create them",
    "Ja, erstelle sie", "Sí, haz", "Sì, fai", "falle", "Yes, definitely",
  ]) {
    assert.equal(isShortYes(yes), true, yes);
    assert.equal(yesWithAddition(yes), false, yes);
  }
});

test("anything else is not a short yes", () => {
  for (const other of [
    "да, но на английски",
    "не",
    "no",
    "Не, благодаря",
    "да видим пощата",
    "Покажи задачите ми",
    "ДА ТЕКСТА Е ОК НО НАНГЛИИСКО И ДА ЕВУРХОНЯКАВО КАРТИНИ ВИДЕ",
    "yes, but in English",
    "Да направиш ли картинките?",
    "Направи още една такава",
    "моля",
    "please",
    "thanks",
    "👍",
    "...",
    "",
    "   ",
    // Seven words are a sentence, even of yes words (six are the owner's
    // „ДА ДАВАЙ НАПРАВИ ГИ ВСИЧКИТЕ СЕГА“, review r5).
    "да да да да да да да",
    // Review r5: a yes that asks back, in every script a phone types it.
    "Да?", "نعم؟", "ہاں؟", "جی؟", "Да❓", "ДА⁉️", "¿Sí", "Yes‽",
    // „Искам да…“ is a request, not „Да, искам“.
    "Искам да",
    "Точно",
    // Review r1: a thanks that only acknowledges closes a topic as often as it
    // agrees, so it never starts paid pictures or video.
    "ok thanks",
    "okey thanks",
    "Alright, thanks",
    "Alright, thank you",
    "добре, благодаря",
    "мерси, ок",
    "Okay, thank you",
    "Vale, gracias",
    "Thank you",
    // Never Russian.
    "давай, конечно",
    undefined,
    null,
    42,
    ["да"],
  ]) {
    assert.equal(isShortYes(other), false, String(other));
  }
});

test("an agreement with something added starts by agreeing", () => {
  for (const addition of [
    "ДА ТЕКСТА Е ОК НО СМЕНИ ЗАГЛАВИЕТО",
    "да, но по-кратко",
    "да, но на английски",
    "Да, но не сега",
    "ok, now in English",
    "yes, but in English",
    "ok then make it shorter",
    "Ja, aber kürzer",
    "Oui, mais en anglais",
    "ДА ТЕКСТА Е ОК НО НАНГЛИИСКО И ДА ЕВУРХОНЯКАВО КАРТИНИ ВИДЕ",
    // Review r1: a thanks that only acknowledges is no short yes, but the
    // model still gets the step and decides.
    "ok thanks",
    "Vale, gracias",
    "мерси, ок",
    "добре, благодаря",
    "Okay, thank you",
    "okey thanks",
    "Alright, thank you",
    // Review r1: a go-ahead word with a comma, a dash, a conjunction or
    // another agreeing word after it.
    "ДАВАЙ НО НА АНГЛИЙСКИ",
    "Давай, но по-кратко",
    "Хайде, но първо картинките",
    "Действай, само смени заглавието",
    "Go ahead but shorter",
    "Dale, pero más corto",
    "Vas-y, mais plus court",
    "Vai, ma più corto",
    "Los, aber kürzer",
    "Hai, dar mai scurt",
    "DA DAVAI, но по-кратко",
  ]) {
    assert.equal(yesWithAddition(addition), true, addition);
    assert.equal(isShortYes(addition), false, addition);
  }
  for (const other of [
    // A bare yes is not one with an addition.
    "да",
    "ДА ДАВАЙ",
    // A verb starts a new request as often as it agrees.
    "Направи още една такава",
    "Do you know the weather?",
    "Go to the settings and turn it off",
    "Продължи с текста за Facebook",
    // Review r1: „да“ as the particle before a verb, and go-ahead words that
    // start another sentence.
    "Да не го правиш",
    "Да изчакаме до утре",
    "Да не бързаме",
    "да видим пощата",
    "Да направиш ли картинките?",
    "Да ги оставим за после",
    "Давай да видим пощата",
    "Става дума за видеото",
    "Може ли да направиш картинка?",
    "Hai visto il video?",
    "Vai alla pagina dei prezzi",
    "Si quieres, hazlo mañana",
    "не, по-кратко",
    "Покажи задачите ми",
    // Over 200 characters is a request of its own.
    `да, ${"и още нещо ".repeat(20)}`,
    undefined,
    {},
  ]) {
    assert.equal(yesWithAddition(other), false, String(other));
  }
});

test("the owner's spellings are short yeses: „и“ for „й“ and Latin with W", () => {
  // Review r2 (server S4): the owner's 27.11 chat types Й as И and writes
  // Latin with W; these lost the step and made nothing after an offer.
  for (const yes of ["ДАВАИ", "ДА ДАВАИ", "DA DAWAI", "ОКЕИ", "ХАИДЕ", "ДЕЙСТВАИ", "NAPRAWI GI", "NAPRAVI GI", "Да, давай сега", "DA DAVAJ"]) {
    assert.equal(isShortYes(yes), true, yes);
    assert.equal(yesWithAddition(yes), false, yes);
  }
});

test("a go-ahead word or „да“ followed by more is a yes with an addition, but the particle „да“ is not", () => {
  // Review r2 (server S4): the owner's capital-letter style without a comma.
  for (const addition of [
    "ДАВАЙ НА АНГЛИЙСКИ",
    "ДАВАЙ ПО-КРАТКО",
    "ДАВАЙ С ВИДЕО",
    "ХАЙДЕ НА АНГЛИЙСКИ",
    "ДАВАИ НА АНГЛИИСКИ",
    // Nouns after „да“: the -ме, -им, -ем and -ш endings no longer make it
    // the particle.
    "ДА ПРОБЛЕМ НЯМА",
    "ДА ВРЕМЕ Е",
    "ДА ИМЕ НЕ ТРЯБВА",
    "ДА СИСТЕМАТА Е ОК",
    // A yes that asks back is no bare yes: the model gets the step with it.
    "Да?",
    "ок?",
    "Yes?",
    "Давай?",
    "ДА ДАВАЙ？",
    // Review r5: the Arabic and Urdu mark, the Spanish opening one and the
    // emoji a phone keyboard offers.
    "نعم؟",
    "ہاں؟",
    "جی؟",
    "Да❓",
    "ДА⁉️",
    "¿Sí",
    "¿Sí?",
  ]) {
    assert.equal(yesWithAddition(addition), true, addition);
    assert.equal(isShortYes(addition), false, addition);
  }
  for (const other of [
    "Да изчакаме до утре",
    "Да не го правиш",
    "Давай да видим пощата",
    "Да направиш ли картинките?",
    "Да направя ли картинките?",
    "Да ги оставим за после",
    "да видим пощата",
    "Да пробваш ли пак?",
    "Да проверя ли пощата?",
    "Да пробваме утре",
    "Go to the settings",
    // Review r5: „Искам да…“ is a request, and so is a verb of drawing.
    "Искам да видя пощата",
    "Нарисувай ги",
    "Генерирай картинка на котка",
  ]) {
    assert.equal(yesWithAddition(other), false, other);
    assert.equal(isShortYes(other), false, other);
  }
});

test("a crafted long message is checked in linear time", () => {
  const size = 100_000;
  for (const message of [
    `да${" ".repeat(size)}x`,
    `да,${" ,".repeat(size / 2)}`,
    `yes ${" ".repeat(size)}please x`,
    "👍".repeat(size / 2),
    "-".repeat(size),
    "да ".repeat(size / 3),
    `${"vas-y ".repeat(size / 6)}`,
    `${"lets do it ".repeat(size / 11)}`,
    `${"разбира се, ".repeat(size / 12)}`,
  ]) {
    const time = fastest(() => {
      assert.equal(isShortYes(message), false);
      assert.equal(yesWithAddition(message), false);
    });
    assert.ok(time < 50, `${time.toFixed(1)} ms`);
  }
  // Up to the limits the words themselves are read, once each.
  for (const message of ["да ".repeat(26), `да,${" -".repeat(38)}`, `да ${"ok ".repeat(65)}`, "go for it ".repeat(20), `да ${"не ".repeat(65)}`]) {
    const time = fastest(() => {
      isShortYes(message);
      yesWithAddition(message);
    });
    assert.ok(time < 20, `${time.toFixed(1)} ms`);
  }
});
