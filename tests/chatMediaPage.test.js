import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, dailyPlan, english, styles, index] = await Promise.all(
  ["../public/app.js", "../public/daily-plan.js", "../public/locale-en.js", "../public/styles.css", "../public/index.html"].map(read),
);
// The English page's catalog, as locale.js reads locale-en.js.
const ENGLISH = Object.fromEntries(
  english
    .split("\n")
    .filter((line) => line.includes("|") && !line.includes("`"))
    .map((line) => line.split("|")),
);
const englishText = (value, values = {}) =>
  (ENGLISH[value] ?? value).replace(/\{(\w+)\}/gu, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
const slice = (from, to) => {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} … ${to}`);
  return app.slice(start, end);
};

const PICTURE_1 = "Чаша кафе на дървена маса, сутрешна светлина";
const PICTURE_2 = "Баристка подава кафе през прозорче, усмихва се";
const VIDEO = "Пара над чаша кафе, после надпис „Добро утро“";
const items = (units = [0, 0, 0]) => [
  { kind: "image", prompt: PICTURE_1, units: units[0], number: 1 },
  { kind: "image", prompt: PICTURE_2, units: units[1], number: 2 },
  { kind: "video", prompt: VIDEO, units: units[2] },
];
const until = async (done, what) => {
  for (let tries = 0; tries < 200 && !done(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

// app.js's cards and queue on a page with the given answers (each one a turn
// the chat gave), with a chatText catalog ({} is the Bulgarian page) and
// stand-in generators for SynchronMedia.
function cardPage(t, { catalog = {}, media = {}, answers = 1, nextCard = true } = {}) {
  const turn = `<div class="assistant-turn chat-answer"><div class="message agent">Отговор</div>${
    nextCard ? '<section class="next-step-card"></section>' : ""
  }<div class="message-actions"></div></div>`;
  const { window } = new JSDOM(`<div id="chat">${turn.repeat(answers)}</div>`);
  const state = { chatBusy: false };
  const page = new Function(
    "document",
    "globalThis",
    "chatText",
    "state",
    "elements",
    `${slice("const MEDIA_BUSY_STATES", "function memoryCandidateCategoryLabel(")}
    return { showMediaProposals, queueMedia, mediaItems, latestMediaCard, busyMediaKeys, cancelQueuedMedia };`,
  )(
    window.document,
    { SynchronMedia: media },
    (value) => catalog[value] ?? value,
    state,
    { chatMessages: window.document.getElementById("chat") },
  );
  t.after(() => window.close());
  const turns = [...window.document.querySelectorAll(".assistant-turn")];
  const at = (number) => {
    const turnNode = turns[number];
    const buttons = () => [...turnNode.querySelectorAll(".media-proposals button")];
    return {
      turn: turnNode,
      buttons,
      labels: () => buttons().map((button) => button.textContent),
      pressed: () => buttons().map((button) => button.disabled),
      show: (event) => page.showMediaProposals(turnNode.querySelector(".message"), event),
      card: () => turnNode.querySelector(".media-proposals"),
    };
  };
  return { ...page, ...at(0), at, window, state };
}

test("the card has a button per item, named by the answer's own number, with the cost only for a member", (t) => {
  const member = cardPage(t);
  member.show({ start: false, items: items([2, 2, 100]) });
  assert.equal(member.card().getAttribute("aria-label"), "Картинки и видео");
  assert.equal(member.card().querySelector("strong").textContent, "Картинки и видео");
  // „Направи всичко“ shows what all of them cost together (review r5).
  assert.deepEqual(member.labels(), [
    "🎨 Картинка 1 · 2 единици",
    "🎨 Картинка 2 · 2 единици",
    "🎬 Видео · 100 единици",
    "Направи всичко · 104 единици",
  ]);
  // L10 #6: each button names the start of its description.
  const [first, , video, all] = member.buttons();
  assert.equal(first.getAttribute("aria-label"), `🎨 Картинка 1 · 2 единици — ${PICTURE_1}`);
  assert.equal(first.title, first.getAttribute("aria-label"));
  assert.equal(video.getAttribute("aria-label"), `🎬 Видео · 100 единици — ${VIDEO}`);
  assert.equal(all.getAttribute("aria-label"), null);
  assert.equal(all.className, "media-proposals-all");
  // Above the Next card, whose step offers to make them; nothing is pressed.
  assert.equal(member.card().nextElementSibling.className, "next-step-card");
  assert.ok(member.buttons().every((button) => !button.disabled));

  // The answer's „Картинка 3:“ is the button's 3; a picture without a number
  // takes the lowest number no picture on the card has, so no two buttons
  // have the same name (review r1: „Картинка 2 | Картинка 2“).
  const numbered = cardPage(t);
  numbered.show({
    start: false,
    items: [
      { kind: "image", prompt: PICTURE_1, units: 0, number: 3 },
      { kind: "image", prompt: PICTURE_2, units: 0 },
      { kind: "image", prompt: `${"Дълго описание на картинката ".repeat(4)}край`, units: 0 },
    ],
  });
  assert.deepEqual(numbered.labels(), ["🎨 Картинка 3", "🎨 Картинка 1", "🎨 Картинка 2", "Направи всичко"]);
  const long = numbered.buttons()[2].getAttribute("aria-label");
  assert.equal(long, `🎨 Картинка 2 — ${"Дълго описание на картинката ".repeat(4).slice(0, 60).trimEnd()}…`);
  for (const [numbers, labels] of [
    [[2, 0], ["🎨 Картинка 2", "🎨 Картинка 1"]],
    [[0, 1], ["🎨 Картинка 2", "🎨 Картинка 1"]],
    [[1, 1], ["🎨 Картинка 1", "🎨 Картинка 2"]],
    [[0, 0], ["🎨 Картинка 1", "🎨 Картинка 2"]],
  ]) {
    const mixed = cardPage(t);
    mixed.show({
      start: false,
      items: [PICTURE_1, PICTURE_2].map((prompt, at) => ({ kind: "image", prompt, units: 0, ...(numbers[at] ? { number: numbers[at] } : {}) })),
    });
    assert.deepEqual(mixed.labels(), [...labels, "Направи всичко"], JSON.stringify(numbers));
  }

  // An English page: every word on the card comes from locale-en.js.
  const englishPage = cardPage(t, { catalog: ENGLISH });
  englishPage.show({ start: false, items: items([2, 2, 100]) });
  assert.equal(englishPage.card().getAttribute("aria-label"), "Pictures and video");
  assert.equal(englishPage.card().querySelector("strong").textContent, "Pictures and video");
  assert.deepEqual(englishPage.labels(), ["🎨 Picture 1 · 2 units", "🎨 Picture 2 · 2 units", "🎬 Video · 100 units", "Make them all · 104 units"]);
});

test("„Направи всичко“ comes only with two or more items, and there is no card without items", (t) => {
  const one = cardPage(t, { nextCard: false });
  one.show({ start: false, items: [{ kind: "video", prompt: VIDEO, units: 0 }] });
  assert.deepEqual(one.labels(), ["🎬 Видео"]);
  // Without a Next card it goes above the answer's buttons, and only once.
  assert.equal(one.card().nextElementSibling.className, "message-actions");
  assert.equal(one.show({ start: false, items: items() }), null);
  assert.equal(one.turn.querySelectorAll(".media-proposals").length, 1);

  const two = cardPage(t);
  two.show({ start: false, items: [{ kind: "image", prompt: PICTURE_1, units: 0 }, { kind: "video", prompt: VIDEO, units: 0 }] });
  assert.deepEqual(two.labels(), ["🎨 Картинка 1", "🎬 Видео", "Направи всичко"]);

  const none = cardPage(t);
  for (const media of [
    undefined,
    null,
    {},
    { start: false, items: [] },
    { start: false, items: [{ kind: "audio", prompt: "песен" }, { kind: "image", prompt: "  " }, { kind: "video" }, null] },
  ]) {
    assert.equal(none.show(media), null);
  }
  assert.equal(none.card(), null);
});

test("the queue makes the items one after another, from any button or a short yes, and never twice on a card", async (t) => {
  const log = [];
  let running = 0;
  const make = (kind) => async (prompt, options) => {
    assert.deepEqual(options, { fromChat: true });
    running += 1;
    assert.equal(running, 1, "two are made at once");
    log.push(`${kind}: ${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return true;
  };
  const page = cardPage(t, { media: { drawImage: make("image"), makeVideo: make("video") } });
  const card = page.show({ start: false, items: items() });
  const [first, second, video, all] = page.buttons();
  first.click();
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  all.click();
  assert.ok(page.buttons().every((button) => button.disabled), "„Направи всичко“ presses them all");
  // A short yes's items, queued on the same card, add nothing new.
  await page.queueMedia(card, page.mediaItems({ start: true, items: items() }));
  assert.deepEqual(log, [`image: ${PICTURE_1}`, `image: ${PICTURE_2}`, `video: ${VIDEO}`]);
  // Pressing again makes nothing.
  second.disabled = false;
  second.click();
  video.click();
  await page.queueMedia(card, []);
  assert.equal(log.length, 3);

  // A short yes after one picture was pressed makes the rest.
  const made = [];
  const yes = cardPage(t, {
    media: {
      drawImage: async (prompt) => (made.push(prompt), true),
      makeVideo: async (prompt) => (made.push(prompt), true),
    },
  });
  const yesCard = yes.show({ start: false, items: items() });
  yes.buttons()[1].click();
  await yes.queueMedia(yesCard, yes.mediaItems({ start: true, items: items() }));
  assert.deepEqual(made, [PICTURE_2, PICTURE_1, VIDEO]);
  assert.ok(yes.buttons().every((button) => button.disabled), "the card shows them as made");
});

test("every card keeps its own state: a new card with a made description can be pressed", async (t) => {
  // L10 #0: the same „Картинка 1:“ under a later answer, or a short yes to it.
  const made = [];
  const page = cardPage(t, { answers: 2, media: { drawImage: async (prompt) => (made.push(prompt), true) } });
  const picture = [{ kind: "image", prompt: PICTURE_1, units: 0, number: 1 }];
  const firstCard = page.at(0).show({ start: false, items: picture });
  page.at(0).buttons()[0].click();
  await page.queueMedia(firstCard, []);
  assert.deepEqual(page.at(0).pressed(), [true]);
  const secondCard = page.at(1).show({ start: false, items: picture });
  assert.deepEqual(page.at(1).pressed(), [false]);
  page.at(1).buttons()[0].click();
  await page.queueMedia(secondCard, []);
  assert.deepEqual(made, [PICTURE_1, PICTURE_1]);
  // A short yes the server started on the newer card makes it there too.
  const third = cardPage(t, { media: { drawImage: async (prompt) => (made.push(prompt), true) } });
  await third.queueMedia(third.show({ start: false, items: picture }), third.mediaItems({ start: true, items: picture }));
  assert.equal(made.length, 3);
});

test("an item that failed can be pressed again, and the made ones stay pressed", async (t) => {
  let fail = true;
  const made = [];
  const page = cardPage(t, {
    media: {
      drawImage: async (prompt) => {
        made.push(prompt);
        if (prompt === PICTURE_2 && fail) throw new Error("няма връзка");
        return true;
      },
      makeVideo: async (prompt) => (made.push(prompt), !fail),
    },
  });
  const card = page.show({ start: false, items: items() });
  page.buttons().at(-1).click();
  await page.queueMedia(card, []);
  assert.deepEqual(made, [PICTURE_1, PICTURE_2, VIDEO]);
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  assert.deepEqual(page.busyMediaKeys(card), [`image:${PICTURE_1}`]);
  fail = false;
  page.buttons().at(-1).click();
  await page.queueMedia(card, []);
  assert.deepEqual(made, [PICTURE_1, PICTURE_2, VIDEO, PICTURE_2, VIDEO]);
  assert.ok(page.buttons().every((button) => button.disabled));

  // Without the page's generators nothing is made and the button comes back.
  const missing = cardPage(t, { media: undefined });
  const missingCard = missing.show({ start: false, items: [{ kind: "image", prompt: PICTURE_1, units: 0 }] });
  missing.buttons()[0].click();
  await missing.queueMedia(missingCard, []);
  assert.equal(missing.buttons()[0].disabled, false);
});

test("a pressed button says whether its items wait, are being made or are made", async (t) => {
  // Review r5 (page-4): queued, running and made buttons looked the same.
  const finish = [];
  const generator = () => new Promise((resolve) => finish.push(resolve));
  const page = cardPage(t, { media: { drawImage: generator, makeVideo: generator } });
  const card = page.show({ start: false, items: items() });
  page.buttons().at(-1).click();
  assert.deepEqual(page.labels(), ["🎨 Картинка 1 · чака", "🎨 Картинка 2 · чака", "🎬 Видео · чака", "Направи всичко · чака"]);
  await until(() => finish.length === 1, "the first picture did not start");
  assert.deepEqual(page.labels(), ["🎨 Картинка 1 · прави се", "🎨 Картинка 2 · чака", "🎬 Видео · чака", "Направи всичко · прави се"]);
  assert.deepEqual(
    page.buttons().map((button) => button.dataset.mediaState),
    ["running", "queued", "queued", "running"],
  );
  // The name a screen reader reads says it too, before the description.
  assert.equal(page.buttons()[0].getAttribute("aria-label"), `🎨 Картинка 1 · прави се — ${PICTURE_1.slice(0, 60).trimEnd()}`);
  finish[0](true);
  await until(() => finish.length === 2, "the second picture did not start");
  finish[1](false);
  await until(() => finish.length === 3, "the clip did not start");
  finish[2](true);
  await page.queueMedia(card, []);
  // A failed item is plain again and can be pressed; „Направи всичко“ too.
  assert.deepEqual(page.labels(), ["🎨 Картинка 1 · готово", "🎨 Картинка 2", "🎬 Видео · готово", "Направи всичко"]);
  assert.deepEqual(page.pressed(), [true, false, true, false]);
  assert.equal(page.buttons()[1].getAttribute("aria-label"), `🎨 Картинка 2 — ${PICTURE_2}`);
  assert.equal(page.buttons()[1].dataset.mediaState, undefined);
  // The English page says it in English.
  const english = cardPage(t, { catalog: ENGLISH, media: { drawImage: async () => true, makeVideo: async () => true } });
  const englishCard = english.show({ start: false, items: items([2, 2, 100]) });
  english.buttons()[0].click();
  await english.queueMedia(englishCard, []);
  assert.deepEqual(english.labels(), ["🎨 Picture 1 · 2 units · done", "🎨 Picture 2 · 2 units", "🎬 Video · 100 units", "Make them all · 104 units"]);
});

test("an edited or retried question keeps what its removed cards made: the card that replaces them shows it made", async (t) => {
  // Review r5 (page-1): after a reload „да“ brought a card, one picture was
  // made from it, and the „да“ was edited. That removed the card, and
  // „Направи всичко“ on the new one made the same picture again.
  const page = resendPage(t);
  page.add("assistant-turn chat-answer", "Ето рекламата.");
  const yes = page.add("user-turn", "да", true);
  const reply = page.add("assistant-turn chat-answer", "Натисни бутоните отдолу.");
  const card = reply.ownerDocument.createElement("section");
  card.className = "media-proposals";
  card.__mediaState = new Map([
    [`image:${PICTURE_1}`, "made"],
    [`image:${PICTURE_2}`, "failed"],
    [`video:${VIDEO}`, "idle"],
  ]);
  reply.append(card);
  page.add("user-turn media-turn", `🎨 ${PICTURE_1}`);
  page.add("assistant-turn media-turn", "картинката");
  page.resendFrom(yes, yes.__request);
  assert.deepEqual(page.sent.at(-1), {
    resend: { text: "да", image: null },
    modelOverride: "",
    madeBefore: [`image:${PICTURE_1}`],
  });
  // The answer that replaces it shows that item made; the rest are made once.
  const made = [];
  const next = cardPage(t, {
    media: {
      drawImage: async (prompt) => (made.push(prompt), true),
      makeVideo: async (prompt) => (made.push(prompt), true),
    },
  });
  const nextCard = next.showMediaProposals(next.turn.querySelector(".message"), { start: false, items: items() }, page.sent.at(-1).madeBefore);
  assert.deepEqual(next.pressed(), [true, false, false, false]);
  assert.equal(next.labels()[0], "🎨 Картинка 1 · готово");
  next.buttons().at(-1).click();
  await next.queueMedia(nextCard, []);
  assert.deepEqual(made, [PICTURE_2, VIDEO]);
  // Any other card starts fresh, and the reply's card gets the made items.
  const other = cardPage(t);
  other.show({ start: false, items: items() });
  assert.deepEqual(other.pressed(), [false, false, false, false]);
  assert.match(app, /function showMediaProposals\(message, media, made = \[\]\)/u);
  assert.match(app, /answeredCard \|\| showMediaProposals\(responseBubble, parsed\.data\.media, madeBefore\)/u);
  assert.match(app, /\} else \{\n\s*showMediaProposals\(responseBubble, parsed\.data\?\.media, madeBefore\);/u);
});

test("„Спри“ cancels the queued items that have not started; the one being made finishes", async (t) => {
  // L10 #3: a member pressed „Направи всичко“, then „Спри“ during picture 1.
  const made = [];
  let finish;
  const page = cardPage(t, {
    media: {
      drawImage: (prompt) =>
        new Promise((resolve) => {
          made.push(prompt);
          finish = () => resolve(true);
        }),
      makeVideo: async (prompt) => (made.push(prompt), true),
    },
  });
  const card = page.show({ start: false, items: items([2, 2, 100]) });
  page.buttons().at(-1).click();
  await until(() => made.length === 1, "picture 1 did not start");
  assert.deepEqual(page.busyMediaKeys(card).length, 3);
  page.cancelQueuedMedia();
  // The two waiting items can be pressed again; picture 1 is still running.
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  finish();
  await page.queueMedia(card, []);
  assert.deepEqual(made, [PICTURE_1]);
  assert.deepEqual(page.busyMediaKeys(card), [`image:${PICTURE_1}`]);
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  // While an answer is being written the queue waits, and „Спри“ empties it.
  page.state.chatBusy = true;
  page.buttons()[1].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  page.cancelQueuedMedia();
  page.state.chatBusy = false;
  await page.queueMedia(card, []);
  assert.deepEqual(made, [PICTURE_1]);
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  // „Спри“ stops the answer and the queue.
  assert.match(slice("function stopGeneration(", "function setChatBusy("), /state\.chatAbort\?\.abort\(\);\n  cancelQueuedMedia\(\);/u);
});

test("focus stays in the card after a press, on the card itself", async (t) => {
  // L10 #5: a pressed button is disabled, which used to drop focus to <body>.
  // Review r5: focus on the next button made one more Enter or Space start
  // an item the person did not choose (a paid video), so it goes to the card.
  const made = [];
  const page = cardPage(t, {
    media: {
      drawImage: async (prompt) => (made.push(`image:${prompt}`), true),
      makeVideo: async (prompt) => (made.push(`video:${prompt}`), true),
    },
  });
  const card = page.show({ start: false, items: items() });
  const [first, second, video, all] = page.buttons();
  first.focus();
  first.click();
  assert.equal(page.window.document.activeElement, card);
  assert.equal(card.tabIndex, -1);
  // One more Enter on the focused card presses nothing.
  card.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await page.queueMedia(card, []);
  assert.deepEqual(made, [`image:${PICTURE_1}`]);
  assert.deepEqual(page.pressed(), [true, false, false, false]);
  all.click();
  assert.equal(page.window.document.activeElement, card);
  await page.queueMedia(card, []);
  assert.ok([first, second, video, all].every((button) => button.disabled));
});

test("the next message carries the latest answer's card: what it has queued, is making or made", async (t) => {
  let finish;
  const page = cardPage(t, {
    answers: 2,
    media: { drawImage: () => new Promise((resolve) => (finish = resolve)), makeVideo: async () => true },
  });
  assert.equal(page.latestMediaCard(), null);
  // A card under an older answer is not the one the next message answers.
  page.at(0).show({ start: false, items: items() });
  assert.equal(page.latestMediaCard(), null);
  const card = page.at(1).show({ start: false, items: items() });
  assert.equal(page.latestMediaCard(), card);
  assert.deepEqual(page.busyMediaKeys(card), []);
  page.at(1).buttons()[2].click();
  page.at(1).buttons()[0].click();
  assert.deepEqual(page.busyMediaKeys(card), [`image:${PICTURE_1}`, `video:${VIDEO}`]);
  // The page's own picture turns and notes after it do not hide it.
  const chat = page.window.document.getElementById("chat");
  chat.insertAdjacentHTML(
    "beforeend",
    '<div class="assistant-turn media-turn"><div class="message agent">🎨 Рисувам…</div></div><div class="assistant-turn"><div class="message agent">⏹ Спряно.</div></div>',
  );
  assert.equal(page.latestMediaCard(), card);
  await until(() => typeof finish === "function", "picture 1 did not start");
  finish(true);
  await page.queueMedia(card, []);
  // A newer answer without a card: nothing is sent.
  chat.insertAdjacentHTML("beforeend", '<div class="assistant-turn chat-answer"><div class="message agent">Друго</div></div>');
  assert.equal(page.latestMediaCard(), null);

  // sendMessage reads the card before the message is added, sends its keys,
  // and queues a short yes's items on that card (or a new one under the
  // reply after a reload); a card from the server otherwise.
  const send = slice("async function sendMessage(", "function rememberConversationMessage(");
  assert.match(
    send,
    /const answeredCard = latestMediaCard\(\);\n  const sentTurn = appendMessage\("user", messageText, image, \{ remember: false \}\)\.closest\("\.user-turn"\);\n  const sentEntry = rememberConversationMessage\("user", messageText\);/u,
  );
  assert.match(send, /\.\.\.\(answeredCard \? \{ mediaCard: \{ made: busyMediaKeys\(answeredCard\) \} \} : \{\}\),/u);
  assert.match(
    send,
    /if \(parsed\.data\?\.media\?\.start === true\) \{\n\s*const card = answeredCard \|\| showMediaProposals\(responseBubble, parsed\.data\.media, madeBefore\);\n\s*if \(card\) void queueMedia\(card, mediaItems\(parsed\.data\.media\)\);\n\s*\} else \{\n\s*showMediaProposals\(responseBubble, parsed\.data\?\.media, madeBefore\);\n\s*\}/u,
  );
  assert.match(send, /const assistantTurn = createAssistantTurn\("", false\);\n\s*assistantTurn\.turn\.classList\.add\("chat-answer"\);/u);
  // The server's own reply to a yes is marked, so the next yes looks past it.
  assert.match(send, /if \(parsed\.data\?\.mode === "media-yes"\) assistantTurn\.turn\.classList\.add\("media-yes-reply"\);/u);
});

test("the next yes looks past the server's own reply to the card that reply answered", (t) => {
  // Review r1 (page): after „да“ and „Спри“, or a press after a reload, the
  // second yes sent no card and went to the model.
  const page = cardPage(t);
  const card = page.show({ start: false, items: items() });
  const chat = page.window.document.getElementById("chat");
  const reply = (text) =>
    chat.insertAdjacentHTML(
      "beforeend",
      `<div class="assistant-turn chat-answer media-yes-reply"><div class="message agent">${text}</div></div>`,
    );
  reply("Правя 2 картинки и видеото.");
  chat.insertAdjacentHTML("beforeend", '<div class="assistant-turn media-turn"><div class="message agent">🎨 картинка</div></div>');
  assert.equal(page.latestMediaCard(), card);
  reply("Те вече се правят или са готови.");
  assert.equal(page.latestMediaCard(), card);
  // A reply with a card of its own (the press reply after a reload) is that card.
  reply("Описанията са в предишния отговор. Натисни бутоните отдолу, за да ги направя.");
  const own = page.showMediaProposals(chat.lastElementChild.querySelector(".message"), { start: false, items: items() });
  assert.equal(page.latestMediaCard(), own);
  reply("Правя картинката и видеото.");
  assert.equal(page.latestMediaCard(), own);
  // Any other answer without a card stops the search.
  chat.insertAdjacentHTML("beforeend", '<div class="assistant-turn chat-answer"><div class="message agent">Друго</div></div>');
  assert.equal(page.latestMediaCard(), null);
  reply("Правя картинката.");
  assert.equal(page.latestMediaCard(), null);
});

test("a new conversation never makes the queued pictures of the one before it", async (t) => {
  // Review r2 (page N4): „Нов разговор“ right after a yes made the queued
  // pictures in the new conversation.
  const made = [];
  const page = cardPage(t, { media: { drawImage: async (prompt) => (made.push(prompt), true) } });
  const card = page.show({ start: false, items: items().slice(0, 2) });
  page.state.chatBusy = true;
  page.buttons().at(-1).click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The chat is emptied for the new conversation while they wait.
  page.window.document.getElementById("chat").replaceChildren();
  page.state.chatBusy = false;
  await page.queueMedia(card, []);
  assert.deepEqual(made, []);
  // „Нов разговор“ and opening another conversation cancel the queue first.
  for (const name of ["async function startNewChat(", "async function openConversation("]) {
    const opening = slice(name, "state.sessionId = ");
    assert.match(opening, /if \(state\.chatBusy[^\n]*\) return;\n(?:\s*\/\/[^\n]*\n)*\s*cancelQueuedMedia\(\);\n/u, name);
  }
});

test("the same description twice in the server's event is one button", (t) => {
  // Review r2 (page N7c): two identical descriptions made two buttons for one
  // item, and the reply counted both.
  const page = cardPage(t);
  page.show({ start: false, items: [...items(), { kind: "image", prompt: PICTURE_1, units: 0, number: 3 }] });
  assert.deepEqual(page.labels(), ["🎨 Картинка 1", "🎨 Картинка 2", "🎬 Видео", "Направи всичко"]);
  assert.equal(page.mediaItems({ items: [items()[0], { ...items()[0], prompt: ` ${PICTURE_1} ` }] }).length, 1);
});

// app.js's history window: rememberConversationMessage and conversationWindow,
// with the real isPageMediaLine.
function historyPage() {
  const state = { recentConversationMessages: [] };
  const page = new Function(
    "state",
    `${slice("function isPageMediaLine(", "// Retry and edit replace")}
    ${slice("const RECENT_TURNS", "// options.remember: false")}
    return { isPageMediaLine, conversationWindow, rememberConversationMessage };`,
  )(state);
  return { ...page, state };
}

test("the history keeps the last 12 turns and the page's own picture and clip lines among them", () => {
  // Review r2 (page F1): a full card (four pictures and a video) adds ten
  // lines, which pushed the request and the offer out of the 12 entries.
  const page = historyPage();
  const turn = (role, content) => page.rememberConversationMessage(role, content);
  const line = (role, content) => page.rememberConversationMessage(role, content, { page: true });
  assert.deepEqual(turn("user", "  Реклама за кафене  "), { role: "user", content: "Реклама за кафене" });
  turn("agent", "Ето рекламата.");
  turn("user", "ДА ДАВАЙ");
  turn("assistant", "Правя 4 картинки и видеото.");
  for (let number = 1; number <= 5; number += 1) {
    line("user", `🎨 Описание ${number}`);
    assert.deepEqual(line("assistant", `🎨 Нарисувах картинка: Описание ${number}`), {
      role: "assistant",
      content: `🎨 Нарисувах картинка: Описание ${number}`,
      page: true,
    });
  }
  assert.equal(page.state.recentConversationMessages.length, 14);
  assert.deepEqual(page.state.recentConversationMessages.slice(0, 2), [
    { role: "user", content: "Реклама за кафене" },
    { role: "assistant", content: "Ето рекламата." },
  ]);
  assert.equal(turn("user", "   "), null);
  assert.equal(turn("system", "x"), null);
  // Only the page's mark makes a page line; a typed "🎬 …" is a turn.
  assert.equal(page.isPageMediaLine({ role: "user", content: "🎬 Видео за кафенето" }), false);
  assert.equal(page.isPageMediaLine({ role: "user", content: "🎬 Видео за кафенето", page: true }), true);
  // Twelve turns stay; the page's lines older than them go.
  for (let number = 1; number <= 10; number += 1) turn(number % 2 ? "user" : "assistant", `Ред ${number}`);
  const kept = page.state.recentConversationMessages;
  assert.equal(kept.filter((item) => !page.isPageMediaLine(item)).length, 12);
  assert.equal(kept.filter(page.isPageMediaLine).length, 10);
  assert.deepEqual(kept[0], { role: "user", content: "ДА ДАВАЙ" });
  turn("user", "Ред 11");
  turn("assistant", "Ред 12");
  turn("user", "Ред 13");
  assert.equal(page.state.recentConversationMessages.filter(page.isPageMediaLine).length, 0);
  assert.equal(page.state.recentConversationMessages.length, 12);
  // At most 24 page lines, the newest.
  for (let number = 1; number <= 30; number += 1) line("assistant", `🎨 Нарисувах картинка: ${number}`);
  const lines = page.state.recentConversationMessages.filter(page.isPageMediaLine);
  assert.equal(lines.length, 24);
  assert.equal(lines[0].content, "🎨 Нарисувах картинка: 7");
  assert.equal(page.state.recentConversationMessages.length, 36);
  assert.deepEqual(page.conversationWindow([]), []);
});

// app.js's real sendMessage, with the real history and message functions and
// stand-ins for the rest of the page; `respond` answers each request.
function sendPage(t, respond) {
  const { window } = new JSDOM('<div id="chat"></div><textarea id="chatInput"></textarea>');
  t.after(() => window.close());
  const document = window.document;
  const elements = { chatMessages: document.getElementById("chat"), chatInput: document.getElementById("chatInput") };
  const state = {
    recentConversationMessages: [],
    chatBusy: false,
    councilMode: false,
    pendingImage: null,
    sessionId: "s1",
    talkMode: false,
    chatAbort: null,
  };
  const history = new Function(
    "state",
    `${slice("function isPageMediaLine(", "// Retry and edit replace")}
    ${slice("const RECENT_TURNS", "// options.remember: false")}
    return { conversationWindow, rememberConversationMessage };`,
  )(state);
  const appendMessage = new Function(
    "document",
    "elements",
    "localizedMarkup",
    "renderAgentText",
    "rememberConversationMessage",
    "scrollChatToBottom",
    `${slice("function createAssistantTurn(", "function showCouncilExecutionAction(")}
    ${slice("function appendMessage(", "function scrollChatToBottom(")}
    return { appendMessage, createAssistantTurn };`,
  )(document, elements, (value) => value, (element, text) => (element.textContent = text), history.rememberConversationMessage, () => {});
  const sent = [];
  const noop = () => {};
  const helpers = {
    document,
    globalThis: {},
    state,
    elements,
    alert: noop,
    setCouncilMode: noop,
    conversationWindow: history.conversationWindow,
    latestMediaCard: () => null,
    appendMessage: appendMessage.appendMessage,
    rememberConversationMessage: history.rememberConversationMessage,
    resizeChatInput: noop,
    clearPendingImage: noop,
    logAction: noop,
    showTypingIndicator: noop,
    setChatBusy: (busy) => (state.chatBusy = busy),
    fetch: async (url, options) => {
      sent.push(JSON.parse(options.body));
      return respond(sent.length);
    },
    chatLocale: null,
    busyMediaKeys: () => [],
    chatText: (value) => value,
    createAssistantTurn: appendMessage.createAssistantTurn,
    removeTypingIndicator: noop,
    renderAgentText: (element, text) => {
      element.textContent = text;
      element.dataset.rawText = text;
    },
    describeAiError: (data) => data?.error || "грешка",
    stopTalkMode: noop,
    scrollChatToBottom: noop,
    loadConversations: async () => {},
    talkSpeak: noop,
    console: { error: noop, log: noop },
    showAiResponseSource: noop,
    showAnswerSources: noop,
    offerTodos: noop,
    showMemoryCandidates: noop,
    showNextStep: noop,
    showMediaProposals: noop,
    queueMedia: noop,
    mediaItems: () => [],
    updateTaskIndicator: noop,
    showConversationPersistenceWarning: noop,
    showCouncilColumns: noop,
    showCouncilExecutionAction: noop,
    loadTaskRuns: noop,
  };
  const sendMessage = new Function(
    ...Object.keys(helpers),
    `${slice("function parseSseEvent(", "async function sendMessage(")}
    ${slice("async function sendMessage(", "// The history sent to the AI:")}
    return sendMessage;`,
  )(...Object.values(helpers));
  const say = async (text) => {
    elements.chatInput.value = text;
    await sendMessage();
  };
  const turns = () => [...elements.chatMessages.children].map((node) => `${node.className}: ${node.querySelector(".message")?.textContent}`);
  return { say, sent, state, turns, chat: elements.chatMessages };
}

// A server answer as an event stream with these events.
const stream = (...events) => {
  const chunks = events.map(([event, data]) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) },
  };
};

test("a question that got no answer leaves the history, so the next „да“ answers the offer above it", async (t) => {
  // Review r2 (page F3): after a failed „да“ the error line was remembered as
  // the answer, so „да“ typed again reached the model bare.
  const responses = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => ({ ok: false, status: 502, headers: { get: () => "text/html" } }),
    () => stream(["token", { token: "Пиша" }], ["error", { error: "Моделът не отговори." }]),
    () => stream(["token", { token: "Правя картинката." }], ["done", { ok: true, mode: "media-yes" }]),
  ];
  const page = sendPage(t, (count) => responses[count - 1]());
  const asked = [
    { role: "user", content: "Реклама за кафене" },
    { role: "assistant", content: "Картинка 1: Чаша кафе на дървена маса\n\nСледва: напиши „да“ и правя картинката." },
  ];
  page.state.recentConversationMessages = [...asked];
  await page.say("да");
  assert.deepEqual(page.state.recentConversationMessages, asked);
  assert.deepEqual(page.turns(), ["user-turn unsent-turn: да", "assistant-turn: ❌ Failed to fetch"]);
  await page.say("да");
  assert.deepEqual(page.state.recentConversationMessages, asked);
  assert.equal(page.turns().at(-1), "assistant-turn: ❌ HTTP 502");
  // An answer that started and then failed is no answer either: the next yes
  // looks past it for the card above.
  await page.say("да");
  assert.deepEqual(page.state.recentConversationMessages, asked);
  assert.equal(page.turns().at(-1), "assistant-turn: ❌ Моделът не отговори.");
  assert.equal(page.chat.querySelectorAll(".chat-answer").length, 0);
  // Every „да“ was sent with the offer as the last answer, never an error.
  for (const body of page.sent) assert.deepEqual(body.recentHistory, asked);
  await page.say("да");
  assert.deepEqual(page.sent.at(-1).recentHistory, asked);
  assert.deepEqual(page.state.recentConversationMessages, [
    ...asked,
    { role: "user", content: "да" },
    { role: "assistant", content: "Правя картинката." },
  ]);
  assert.equal(page.chat.querySelectorAll(".unsent-turn").length, 3);
  assert.equal(page.chat.querySelectorAll(".chat-answer").length, 1);
});

test("a note about a file that cannot be sent is translated and kept out of the history, so the next „да“ still answers the offer", async (t) => {
  // Review r5 (page-2): the three notes were remembered as the answer, and a
  // short yes after one of them no longer reached the picture offer.
  const { window } = new JSDOM('<img id="attachment"><span id="name"></span><div id="preview" hidden></div><textarea id="input"></textarea>');
  t.after(() => window.close());
  const notes = [];
  let readerFails = false;
  class Reader {
    readAsDataURL() {
      setTimeout(() => (readerFails ? this.onerror() : ((this.result = "data:image/png;base64,AA"), this.onload())));
    }
  }
  const pick = new Function(
    "appendMessage",
    "chatText",
    "clearPendingImage",
    "state",
    "elements",
    "FileReader",
    `${slice("function handleImageSelection(", "function clearPendingImage(")}
    return handleImageSelection;`,
  )(
    (role, text, image, options) => notes.push({ role, text, image, options }),
    (value) => ENGLISH[value] ?? `?${value}`,
    () => {},
    {},
    {
      attachmentImage: window.document.getElementById("attachment"),
      attachmentName: window.document.getElementById("name"),
      attachmentPreview: window.document.getElementById("preview"),
      chatInput: window.document.getElementById("input"),
    },
    Reader,
  );
  const choose = (file) => pick({ target: { files: [file] } });
  choose({ type: "text/plain", size: 10, name: "бележка.txt" });
  choose({ type: "image/png", size: 6 * 1024 * 1024, name: "голяма.png" });
  readerFails = true;
  choose({ type: "application/pdf", size: 10, name: "документ.pdf" });
  await until(() => notes.length === 3, "the failed read gave no note");
  assert.deepEqual(notes, [
    { role: "agent", text: "❌ Only JPEG, PNG and WebP pictures and PDF documents are supported.", image: null, options: { remember: false } },
    { role: "agent", text: "❌ The file must be 5 MB or smaller.", image: null, options: { remember: false } },
    { role: "agent", text: "❌ The file could not be read.", image: null, options: { remember: false } },
  ]);
  // A file that can be sent gives no note.
  readerFails = false;
  choose({ type: "image/png", size: 10, name: "снимка.png" });
  await until(() => !window.document.getElementById("preview").hidden, "the picture was not shown");
  assert.equal(notes.length, 3);
});

// app.js's retry and edit on a chat of plain nodes: each a turn with its
// class, and a question with its __request.
function resendPage(t) {
  const { window } = new JSDOM('<div id="chat"></div>');
  t.after(() => window.close());
  const chat = window.document.getElementById("chat");
  const add = (className, text, asked = false) => {
    const node = window.document.createElement("div");
    node.className = className;
    node.textContent = text;
    if (asked) node.__request = { text, image: null };
    chat.append(node);
    return node;
  };
  const state = { recentConversationMessages: [] };
  const sent = [];
  const page = new Function(
    "state",
    "logAction",
    "sendMessage",
    `${slice("function previousUserTurn(", "function openRetryModelMenu(")}
    return { previousUserTurn, resendFrom };`,
  )(state, () => {}, (options) => sent.push(options));
  return { ...page, add, chat, state, sent };
}

test("retry and edit keep the page's own pictures and clips, on the screen and in the history", (t) => {
  // Review r1 (page): editing the yes after its pictures and clip were made
  // removed them (a member had paid 104 units), kept their card locked, and
  // the yes sent again was told they were ready.
  const page = resendPage(t);
  const ad = page.add("user-turn", "Реклама за кафене", true);
  const offer = page.add("assistant-turn chat-answer", "Ето рекламата.");
  const yes = page.add("user-turn", "ДА ДАВАЙ", true);
  const reply = page.add("assistant-turn chat-answer media-yes-reply", "Правя картинката и видеото.");
  const made = [
    page.add("user-turn media-turn", `🎨 ${PICTURE_2}`),
    page.add("assistant-turn media-turn", "картинката"),
    page.add("user-turn media-turn", `🎬 ${VIDEO}`),
    page.add("assistant-turn media-turn", "видеото"),
  ];
  // The page marks its own lines (SynchronChat.remember).
  const lines = [
    { role: "user", content: `🎨 ${PICTURE_2}`, page: true },
    { role: "assistant", content: `🎨 Нарисувах картинка: ${PICTURE_2}`, page: true },
    { role: "user", content: `🎬 ${VIDEO}`, page: true },
    { role: "assistant", content: `🎬 Направих видео: ${VIDEO}`, page: true },
  ];
  const asked = [
    { role: "user", content: "Реклама за кафене" },
    { role: "assistant", content: "Ето рекламата." },
  ];
  page.state.recentConversationMessages = [
    ...asked,
    { role: "user", content: "ДА ДАВАЙ" },
    { role: "assistant", content: "Правя картинката и видеото." },
    ...lines,
  ];
  // Retry on the reply starts from the yes; the edit of the yes does the same.
  assert.equal(page.previousUserTurn(reply), yes);
  page.resendFrom(yes, yes.__request);
  assert.deepEqual([...page.chat.children], [ad, offer, ...made]);
  assert.deepEqual(page.state.recentConversationMessages, [...asked, ...lines]);
  assert.deepEqual(page.sent, [{ resend: { text: "ДА ДАВАЙ", image: null }, modelOverride: "", madeBefore: [] }]);
  // The question before an answer is found past the page's own lines, and a
  // question further up keeps them too.
  const question = page.add("user-turn", "Напиши текст", true);
  const own = page.add("user-turn media-turn", `🎨 ${PICTURE_1}`);
  const answer = page.add("assistant-turn chat-answer", "Ето текста.");
  page.state.recentConversationMessages.push(
    { role: "user", content: "Напиши текст" },
    { role: "user", content: `🎨 ${PICTURE_1}`, page: true },
    { role: "assistant", content: "Ето текста." },
  );
  assert.equal(page.previousUserTurn(answer), question);
  page.resendFrom(ad, ad.__request, "gemini");
  assert.deepEqual([...page.chat.children], [...made, own]);
  assert.deepEqual(page.state.recentConversationMessages, [...lines, { role: "user", content: `🎨 ${PICTURE_1}`, page: true }]);
  assert.deepEqual(page.sent.at(-1), { resend: { text: "Реклама за кафене", image: null }, modelOverride: "gemini", madeBefore: [] });
});

test("retry and edit tell the page's own lines by its mark: a typed „🎬 …“ message or answer is cut like any other", (t) => {
  // Review r2 (page F2): a typed message or a one-line answer that starts with
  // "🎬 " was kept as a page line and counted wrong, so the cut removed the
  // request and the offer above it.
  const page = resendPage(t);
  const typed = [
    { role: "user", content: "Реклама за кафене" },
    { role: "assistant", content: "Ето рекламата." },
  ];
  const ask = page.add("user-turn", "🎬 Видео за рекламата", true);
  page.add("assistant-turn chat-answer", "🎬 Готово: ето сценария.");
  const yes = page.add("user-turn", "да", true);
  page.add("assistant-turn chat-answer", "Правя видеото.");
  page.state.recentConversationMessages = [
    ...typed,
    { role: "user", content: "🎬 Видео за рекламата" },
    { role: "assistant", content: "🎬 Готово: ето сценария." },
    { role: "user", content: "да" },
    { role: "assistant", content: "Правя видеото." },
  ];
  page.resendFrom(yes, yes.__request);
  assert.deepEqual(page.state.recentConversationMessages, [
    ...typed,
    { role: "user", content: "🎬 Видео за рекламата" },
    { role: "assistant", content: "🎬 Готово: ето сценария." },
  ]);
  page.resendFrom(ask, ask.__request);
  assert.deepEqual(page.state.recentConversationMessages, typed);
});

test("a question that got no answer is not counted by retry and edit", (t) => {
  // Review r2 (page F3): a failed question leaves the history, so the cut of a
  // later retry must not count it.
  const page = resendPage(t);
  const ad = page.add("user-turn", "Реклама за кафене", true);
  page.add("assistant-turn chat-answer", "Ето рекламата.");
  page.add("user-turn unsent-turn", "да", true);
  page.add("assistant-turn", "❌ HTTP 502");
  const again = page.add("user-turn", "да", true);
  page.add("assistant-turn chat-answer", "Правя картинката.");
  const asked = [
    { role: "user", content: "Реклама за кафене" },
    { role: "assistant", content: "Ето рекламата." },
  ];
  page.state.recentConversationMessages = [...asked, { role: "user", content: "да" }, { role: "assistant", content: "Правя картинката." }];
  page.resendFrom(again, again.__request);
  assert.deepEqual(page.state.recentConversationMessages, asked);
  // Editing the failed question itself cuts nothing that was sent.
  page.state.recentConversationMessages = [...asked];
  const failed = page.chat.querySelector(".unsent-turn");
  page.resendFrom(failed, failed.__request);
  assert.deepEqual(page.state.recentConversationMessages, asked);
  assert.deepEqual([...page.chat.children], [ad, page.chat.children[1]]);
});

// app.js's appendMessage and createAssistantTurn on an empty chat.
function messagePage(t) {
  const { window } = new JSDOM('<div id="chat"></div>');
  t.after(() => window.close());
  const remembered = [];
  const append = new Function(
    "document",
    "elements",
    "localizedMarkup",
    "renderAgentText",
    "rememberConversationMessage",
    "scrollChatToBottom",
    `${slice("function createAssistantTurn(", "function showCouncilExecutionAction(")}
    ${slice("function appendMessage(", "function scrollChatToBottom(")}
    return appendMessage;`,
  )(
    window.document,
    { chatMessages: window.document.getElementById("chat") },
    (value) => value,
    (element, text) => {
      element.textContent = text;
    },
    (role, text) => remembered.push({ role, text }),
    () => {},
  );
  return { append, remembered, document: window.document };
}

test("the page's own picture and clip turns have no retry or edit", (t) => {
  // L22 #6: „Пробвай пак“ under a clip removed it and sent its description.
  const page = messagePage(t);
  page.append("user", `🎬 ${VIDEO}`, null, { media: true, remember: false });
  page.append("agent", "🎬 Правя видеото…", null, { media: true, remember: false });
  page.append("user", "Напиши текст", null);
  page.append("agent", "Ето текста.", null);
  const [mediaUser, mediaAnswer, user, answer] = page.document.querySelectorAll("#chat > div");
  assert.ok(mediaUser.classList.contains("media-turn"));
  assert.equal(mediaUser.querySelector('[data-action="edit"]'), null);
  assert.equal(mediaUser.__request, undefined);
  assert.ok(mediaUser.querySelector('[data-action="copy"]'));
  assert.ok(mediaAnswer.classList.contains("media-turn"));
  assert.equal(mediaAnswer.querySelector('[data-action="retry"], [data-action="retry-model"]'), null);
  assert.ok(mediaAnswer.querySelector('[data-action="copy"]'));
  // Everything else keeps them.
  assert.ok(user.querySelector('[data-action="edit"]'));
  assert.deepEqual(user.__request, { text: "Напиши текст", image: null });
  assert.equal(answer.querySelectorAll('[data-action="retry"], [data-action="retry-model"]').length, 2);
  assert.ok(!answer.classList.contains("media-turn"));
  assert.deepEqual(page.remembered, [
    { role: "user", text: "Напиши текст" },
    { role: "agent", text: "Ето текста." },
  ]);
});

test("talk mode keeps listening after a spoken yes or a press starts pictures", () => {
  // L10 #2: listening stopped while the chat was busy with a picture.
  const timers = [];
  const state = { talkMode: true, listening: false, chatBusy: true, recognition: { start: () => (state.listening = true) }, talkEmpty: 0 };
  const elements = { chatInput: { value: "" } };
  const sent = [];
  const talk = new Function(
    "state",
    "elements",
    "sendMessage",
    "stopTalkMode",
    "TALK_STOP_WORDS",
    "TALK_MAX_EMPTY",
    "resizeChatInput",
    "startServerRecording",
    "setTimeout",
    "clearTimeout",
    `${slice("function talkListen(", "// Plain words for reading aloud")}
    return { talkListen, talkAfterListening };`,
  )(
    state,
    elements,
    async () => sent.push(elements.chatInput.value),
    () => (state.talkMode = false),
    /^стоп$/u,
    3,
    () => {},
    async () => {},
    (run, ms) => timers.push({ run, ms }),
    () => {},
  );
  talk.talkListen();
  assert.equal(state.listening, false);
  assert.deepEqual(timers.map(({ ms }) => ms), [500]);
  // Still busy: it waits again; free: it listens.
  timers.shift().run();
  assert.equal(timers.length, 1);
  state.chatBusy = false;
  timers.shift().run();
  assert.equal(state.listening, true);
  assert.equal(state.talkMode, true);
  // Something said while a picture is still being made is sent once the
  // chat is free, not dropped.
  state.listening = false;
  state.chatBusy = true;
  elements.chatInput.value = "и още една";
  talk.talkAfterListening();
  assert.deepEqual(sent, []);
  state.chatBusy = false;
  timers.shift().run();
  assert.deepEqual(sent, ["и още една"]);
  assert.equal(state.talkMode, true);
});

// daily-plan.js on a page with the chat box, a stand-in SynchronChat and fetch.
function generatorPage(t, { busy = false, respond, englishPage = false } = {}) {
  const { window } = new JSDOM('<textarea id="chatInput"></textarea><div id="chatMessages"></div>', {
    url: "https://cloudaicore.com/",
    runScripts: "outside-only",
  });
  // daily-plan.js also starts its morning-plan timer; closing stops it.
  t.after(() => window.close());
  const appended = [];
  const remembered = [];
  const posts = [];
  const revoked = [];
  const chat = {
    busyNow: busy,
    busy: () => chat.busyNow,
    setBusy: (value) => {
      chat.busyNow = value;
    },
    append: (role, text, options = {}) => {
      appended.push({ role, text, remember: options.remember !== false, media: options.media === true });
      if (options.remember !== false) remembered.push({ role, content: text });
      const bubble = window.document.createElement("div");
      bubble.className = `message ${role}`;
      bubble.textContent = text;
      window.document.getElementById("chatMessages").append(bubble);
      return bubble;
    },
    remember: (role, text) => remembered.push({ role, content: text }),
    renderMarkdown: (element, text) => {
      element.textContent = text;
    },
  };
  window.SynchronChat = chat;
  if (englishPage) window.NovariumLocale = { text: englishText };
  window.URL.createObjectURL = () => "blob:https://cloudaicore.com/clip";
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  window.fetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return respond(url, window);
  };
  window.eval(dailyPlan);
  const input = window.document.getElementById("chatInput");
  const bubbles = () => [...window.document.querySelectorAll("#chatMessages .message")].map((node) => node.textContent);
  return { window, chat, appended, remembered, posts, revoked, input, bubbles, media: window.SynchronMedia };
}
const picture = async () => ({ ok: true, json: async () => ({ image: "data:image/png;base64,iVBORw0KGgo=" }) });
const clip = async (url, window) => ({ ok: true, blob: async () => new window.Blob(["MP4"], { type: "video/mp4" }) });

test("from the chat a description is made without touching the box, after the chat is free", async (t) => {
  const page = generatorPage(t, { busy: true, respond: picture });
  page.input.value = "черновата ми";
  const result = page.media.drawImage(`  ${PICTURE_1} `, { fromChat: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(page.posts, [], "it waits while an answer is being written");
  page.chat.busyNow = false;
  assert.equal(await result, true);
  assert.deepEqual(page.posts, [{ url: "/api/images", body: { prompt: PICTURE_1 } }]);
  assert.equal(page.input.value, "черновата ми");
  assert.equal(page.chat.busy(), false);
  // The person's line and the progress line are the page's own turns (no
  // retry or edit); the history gets the line and the result, both brief.
  assert.deepEqual(page.appended, [
    { role: "user", text: `🎨 ${PICTURE_1}`, remember: false, media: true },
    { role: "agent", text: "🎨 Рисувам… това отнема до половин минута.", remember: false, media: true },
  ]);
  const figure = page.window.document.querySelector(".generated-image");
  assert.equal(figure.querySelector("img").getAttribute("alt"), PICTURE_1);
  assert.equal(figure.querySelector("a[download]").textContent, "Изтегли картинката");
  assert.deepEqual(page.remembered, [
    { role: "user", content: `🎨 ${PICTURE_1}` },
    { role: "assistant", content: `🎨 Нарисувах картинка: ${PICTURE_1}` },
  ]);
  // Copy, Read aloud, search and export read the made line, not „Рисувам…“
  // (review r5, page-6).
  assert.equal(figure.closest(".message").dataset.rawText, `🎨 Нарисувах картинка: ${PICTURE_1}`);
});

test("a clip from the chat keeps Download and Upload to YouTube, and its file is freed when its turn leaves", async (t) => {
  const page = generatorPage(t, { respond: clip });
  assert.equal(await page.media.makeVideo(VIDEO, { fromChat: true }), true);
  assert.deepEqual(page.posts, [{ url: "/api/videos", body: { prompt: VIDEO } }]);
  const figure = page.window.document.querySelector(".generated-video");
  assert.equal(figure.querySelector("video").getAttribute("src"), "blob:https://cloudaicore.com/clip");
  assert.equal(figure.querySelector("a[download]").getAttribute("download"), "novarium-video.mp4");
  assert.equal(figure.querySelector('[data-action="video-youtube"]').textContent, "Качи в YouTube");
  assert.deepEqual(page.remembered, [
    { role: "user", content: `🎬 ${VIDEO}` },
    { role: "assistant", content: `🎬 Направих видео: ${VIDEO}` },
  ]);
  assert.equal(figure.closest(".message").dataset.rawText, `🎬 Направих видео: ${VIDEO}`);
  assert.deepEqual(page.appended.map(({ remember, media }) => [remember, media]), [[false, true], [false, true]]);
  // L10 #8: „Нов разговор“ empties the chat; the clip's blob URL is revoked.
  assert.deepEqual(page.revoked, []);
  page.window.document.getElementById("chatMessages").replaceChildren();
  await until(() => page.revoked.length === 1, "the clip's URL was not revoked");
  assert.deepEqual(page.revoked, ["blob:https://cloudaicore.com/clip"]);
});

test("a failure stays visible and adds only the person's line to the history; a long description is cut to 200 characters", async (t) => {
  const page = generatorPage(t, {
    respond: async () => ({ ok: false, json: async () => ({ error: "Нямаш достатъчно единици." }) }),
  });
  assert.equal(await page.media.drawImage(PICTURE_1, { fromChat: true }), false);
  assert.equal(page.bubbles().at(-1), "❌ Нямаш достатъчно единици.");
  assert.deepEqual(page.remembered, [{ role: "user", content: `🎨 ${PICTURE_1}` }]);
  assert.equal(page.chat.busy(), false);

  const long = generatorPage(t, { respond: picture });
  const description = `${"Много дълго описание на картинката. ".repeat(8)}\nКрай.`;
  assert.equal(await long.media.drawImage(description, { fromChat: true }), true);
  // Shown whole; remembered as one line of at most 200 characters, so the
  // server knows it for the page's own line.
  assert.equal(long.appended[0].text, `🎨 ${description}`);
  for (const { content } of long.remembered) {
    const shown = content.replace(/^🎨 (?:Нарисувах картинка: )?/u, "");
    assert.equal(Array.from(shown).length, 200);
    assert.ok(shown.endsWith("…") && !shown.includes("\n"));
  }
});

test("an English page shows and remembers the English lines", async (t) => {
  const page = generatorPage(t, { englishPage: true, respond: picture });
  assert.equal(await page.media.drawImage(PICTURE_1, { fromChat: true }), true);
  assert.equal(page.appended[1].text, "🎨 Drawing… this takes up to half a minute.");
  assert.equal(page.window.document.querySelector(".generated-image a[download]").textContent, "Download the picture");
  assert.deepEqual(page.remembered.at(-1), { role: "assistant", content: `🎨 Drew a picture: ${PICTURE_1}` });
});

test("from the chat it gives up after five minutes of a busy chat, without showing anything", async (t) => {
  const page = generatorPage(t, { busy: true, respond: picture });
  let now = 1_000_000;
  page.window.Date.now = () => now;
  const result = page.media.drawImage(PICTURE_1, { fromChat: true });
  now += 5 * 60 * 1000;
  assert.equal(await result, false);
  assert.deepEqual(page.posts, []);
  assert.deepEqual(page.bubbles(), []);
});

test("the „+“ menu still uses the box: reads and clears it, hints when it is empty, waits for nothing", async (t) => {
  const page = generatorPage(t, { respond: picture });
  const draw = (detail) =>
    page.window.document.dispatchEvent(new page.window.CustomEvent("novarium:draw-image", detail ? { detail } : undefined));
  draw();
  assert.match(page.input.placeholder, /Първо опиши картинката/u);
  assert.deepEqual(page.posts, []);
  page.chat.busyNow = true;
  page.input.value = "котка на луната";
  draw();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.input.value, "котка на луната", "a busy chat leaves the box as it is");
  assert.deepEqual(page.posts, []);
  page.chat.busyNow = false;
  draw();
  assert.equal(page.input.value, "", "the box is cleared at once");
  await until(() => page.window.document.querySelector(".generated-image"), "no picture");
  assert.deepEqual(page.posts, [{ url: "/api/images", body: { prompt: "котка на луната" } }]);
  assert.equal(page.bubbles()[0], "🎨 котка на луната");
  // Its history, too, keeps what was made rather than "Рисувам…".
  assert.deepEqual(page.remembered, [
    { role: "user", content: "🎨 котка на луната" },
    { role: "assistant", content: "🎨 Нарисувах картинка: котка на луната" },
  ]);

  // An event with a description makes that one and leaves the box alone.
  page.input.value = "друго";
  draw({ prompt: PICTURE_2 });
  await until(() => page.posts.length === 2, "the description was not made");
  assert.deepEqual(page.posts[1], { url: "/api/images", body: { prompt: PICTURE_2 } });
  assert.equal(page.input.value, "друго");
  await until(() => !page.chat.busy(), "the chat stayed busy");

  // The video entry of the "+" menu works the same way.
  page.input.value = "реклама за кафене";
  page.window.document.dispatchEvent(new page.window.CustomEvent("novarium:make-video"));
  assert.equal(page.input.value, "");
  await until(() => page.posts.length === 3, "the video was not asked for");
  assert.deepEqual(page.posts[2], { url: "/api/videos", body: { prompt: "реклама за кафене" } });
});

test("the chat API, the English lines, the card's look and the new asset versions", async () => {
  assert.match(app, /append: \(role, text, options\) => appendMessage\(role, text, null, options\),/u);
  // Its remembered lines are marked as the page's own (review r2).
  assert.match(app, /remember: \(role, text\) => rememberConversationMessage\(role, text, \{ page: true \}\),/u);
  assert.match(dailyPlan, /globalThis\.SynchronMedia = \{ drawImage, makeVideo \};/u);
  for (const line of [
    "Картинки и видео|Pictures and video",
    "Картинка|Picture",
    "Видео|Video",
    "Направи всичко|Make them all",
    "единици|units",
    "🎨 Нарисувах картинка: {prompt}|🎨 Drew a picture: {prompt}",
    "🎬 Направих видео: {prompt}|🎬 Made a video: {prompt}",
    "Пиша отговора…|Writing the answer…",
  ]) {
    assert.ok(english.split("\n").includes(line), line);
  }
  // Review r5 (page-5): the card, progress, download and file lines are in
  // the five other catalogs too, not English on their pages.
  const catalogs = await Promise.all(
    ["de", "es", "fr", "it", "ro"].map(async (code) => [code, JSON.parse(await read(`../public/locales/${code}.json`))]),
  );
  for (const line of [
    "Картинки и видео",
    "Картинка",
    "Видео",
    "Направи всичко",
    "единици",
    "чака",
    "прави се",
    "готово",
    "🎨 Рисувам… това отнема до половин минута.",
    "🎬 Правя видеото… това отнема от една до четири минути. Не затваряй страницата.",
    "Изтегли картинката",
    "Изтегли видеото",
    "🎨 Нарисувах картинка: {prompt}",
    "🎬 Направих видео: {prompt}",
    "Пиша отговора…",
    "❌ Поддържат се JPEG, PNG и WebP снимки и PDF документи.",
    "❌ Файлът трябва да е до 5 MB.",
    "❌ Файлът не можа да бъде прочетен.",
  ]) {
    assert.ok(ENGLISH[line], line);
    for (const [code, catalog] of catalogs) {
      assert.ok(catalog[ENGLISH[line]] && catalog[ENGLISH[line]] !== line, `${code}: ${line}`);
      assert.equal(catalog[ENGLISH[line]].includes("{prompt}"), line.includes("{prompt}"), `${code}: ${line}`);
    }
  }
  assert.doesNotMatch(english, /^Направи видеото\|/mu);
  assert.doesNotMatch(english, /Задачата не изисква външен инструмент/u);
  // The card looks like the Next card, and its buttons wrap on a phone.
  assert.match(styles, /\.next-step-card,\n\.media-proposals \{/u);
  assert.match(styles, /\.media-proposals-buttons \{\n  display: flex;\n  flex-wrap: wrap;/u);
  // The changed scripts are loaded under a new version.
  for (const asset of [
    "/locale-en.js?v=20261128-tools2",
    "/work-mode.js?v=20261127-media-v2",
    "/assets/20261127-media-v4/app.js",
    "/daily-plan.js?v=20261127-media-v3",
  ]) {
    assert.ok(index.includes(`src="${asset}"`), asset);
  }
});
