import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

// The history in the sidebar shows the latest few conversations and keeps
// the rest in an "Още разговори" drop-down (РАДКО, 28.11: the list was too
// long). These tests run app.js's real list code on a small page.
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, english, neon, shell] = await Promise.all(
  ["../public/app.js", "../public/locale-en.js", "../public/app-neon.css", "../public/appshell.css"].map(read),
);
const slice = (from, to) => {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to}`);
  return app.slice(start, end);
};
const ENGLISH = Object.fromEntries(
  english
    .split("\n")
    .filter((line) => line.includes("|") && !line.includes("`"))
    .map((line) => line.split("|")),
);

const chats = (count) =>
  Array.from({ length: count }, (_, index) => ({ sessionId: `chat-${index + 1}`, title: `Разговор ${index + 1}` }));

function listPage(t, { conversations = chats(12), sessionId = "new", chatText = (value) => value } = {}) {
  const { window } = new JSDOM('<input id="search"><div id="list"></div>');
  t.after(() => window.close());
  const { document } = window;
  const elements = { conversationSearch: document.getElementById("search"), conversationList: document.getElementById("list") };
  const state = { conversations, conversationLoadError: "", sessionId, olderConversationsOpen: false };
  const opened = [];
  const list = new Function(
    "document",
    "elements",
    "state",
    "chatText",
    "openConversation",
    `${slice("const RECENT_CONVERSATIONS", "let statusReturnFocus")}
    ${slice("function renderConversationList(", "async function openConversation(")}
    return { renderConversationList, handleConversationClick, RECENT_CONVERSATIONS };`,
  )(document, elements, state, chatText, async (id) => opened.push(id));
  // A press the way the page gets it: a click on the list, from the pressed node.
  const press = (node) => list.handleConversationClick({ target: node });
  const shown = () => [...elements.conversationList.querySelectorAll(":scope > .conversation")].map((node) => node.textContent);
  const toggle = () => elements.conversationList.querySelector(":scope > .conversation-more");
  const menu = () => elements.conversationList.querySelector(":scope > #olderConversations");
  const inMenu = () => [...(menu()?.querySelectorAll(".conversation") || [])].map((node) => node.textContent);
  list.renderConversationList();
  return { ...list, document, elements, state, opened, press, shown, toggle, menu, inMenu };
}

test("the history shows the latest five conversations and keeps the others in „Още разговори“", async (t) => {
  const page = listPage(t);
  assert.equal(page.RECENT_CONVERSATIONS, 5);
  assert.deepEqual(page.shown(), ["Разговор 1", "Разговор 2", "Разговор 3", "Разговор 4", "Разговор 5"]);
  assert.equal(page.toggle().textContent, "Още разговори (7)");
  assert.equal(page.toggle().type, "button");
  assert.equal(page.toggle().getAttribute("aria-controls"), "olderConversations");
  assert.equal(page.toggle().getAttribute("aria-expanded"), "false");
  assert.equal(page.toggle().querySelector("i").getAttribute("aria-hidden"), "true");
  assert.equal(page.menu().hidden, true);
  assert.deepEqual(page.inMenu(), ["Разговор 6", "Разговор 7", "Разговор 8", "Разговор 9", "Разговор 10", "Разговор 11", "Разговор 12"]);
  // The toggle sits right after the latest five, the menu right after it.
  assert.equal(page.toggle().previousElementSibling.textContent, "Разговор 5");
  assert.equal(page.toggle().nextElementSibling, page.menu());

  // A press on the words of the toggle opens the menu; a second press closes it.
  await page.press(page.toggle().querySelector("span"));
  assert.equal(page.menu().hidden, false);
  assert.equal(page.toggle().getAttribute("aria-expanded"), "true");
  assert.equal(page.state.olderConversationsOpen, true);
  assert.deepEqual(page.opened, []);
  // The list is drawn again (a new conversation, a search cleared): the menu stays open.
  page.renderConversationList();
  assert.equal(page.menu().hidden, false);
  assert.equal(page.toggle().getAttribute("aria-expanded"), "true");
  await page.press(page.toggle().querySelector("i"));
  assert.equal(page.menu().hidden, true);
  assert.equal(page.toggle().getAttribute("aria-expanded"), "false");
  assert.equal(page.state.olderConversationsOpen, false);
});

test("an older conversation opens from the menu and then stays in sight while it is open", async (t) => {
  const page = listPage(t);
  await page.press(page.toggle());
  await page.press(page.menu().querySelector('[data-session-id="chat-9"]'));
  assert.deepEqual(page.opened, ["chat-9"]);

  // openConversation draws the list again with chat-9 open.
  page.state.sessionId = "chat-9";
  page.renderConversationList();
  assert.deepEqual(page.shown(), ["Разговор 1", "Разговор 2", "Разговор 3", "Разговор 4", "Разговор 5", "Разговор 9"]);
  assert.ok(page.elements.conversationList.querySelector(':scope > [data-session-id="chat-9"]').classList.contains("active"));
  assert.equal(page.toggle().textContent, "Още разговори (6)");
  assert.deepEqual(page.inMenu(), ["Разговор 6", "Разговор 7", "Разговор 8", "Разговор 10", "Разговор 11", "Разговор 12"]);

  // One of the latest five that is open stays where it is.
  page.state.sessionId = "chat-2";
  page.renderConversationList();
  assert.deepEqual(page.shown(), ["Разговор 1", "Разговор 2", "Разговор 3", "Разговор 4", "Разговор 5"]);
  assert.equal(page.elements.conversationList.querySelectorAll(".active").length, 1);
  assert.equal(page.toggle().textContent, "Още разговори (7)");
});

test("a search shows every match, and a short history has no drop-down", (t) => {
  const page = listPage(t);
  page.elements.conversationSearch.value = "  РАЗГОВОР 1 ";
  page.renderConversationList();
  assert.deepEqual(page.shown(), ["Разговор 1", "Разговор 10", "Разговор 11", "Разговор 12"]);
  assert.equal(page.toggle(), null);
  assert.equal(page.menu(), null);
  page.elements.conversationSearch.value = "";
  page.renderConversationList();
  assert.equal(page.shown().length, 5);
  assert.equal(page.toggle().textContent, "Още разговори (7)");

  for (const [count, toggle] of [[1, null], [5, null], [6, "Още разговори (1)"]]) {
    const short = listPage(t, { conversations: chats(count) });
    assert.equal(short.shown().length, Math.min(count, 5), `${count}`);
    assert.equal(short.toggle()?.textContent ?? null, toggle, `${count}`);
  }
  // Six conversations with the sixth open: all six in sight, no drop-down.
  const six = listPage(t, { conversations: chats(6), sessionId: "chat-6" });
  assert.equal(six.shown().length, 6);
  assert.equal(six.toggle(), null);

  // No conversations, or a failed load, still say so.
  const empty = listPage(t, { conversations: [] });
  assert.equal(empty.elements.conversationList.textContent, "Все още няма запазени разговори.");
});

test("„Още разговори“ speaks the page's language and looks like the new design", (t) => {
  assert.equal(ENGLISH["Още разговори"], "More conversations");
  const page = listPage(t, { chatText: (value) => ENGLISH[value] ?? value });
  assert.equal(page.toggle().textContent, "More conversations (7)");
  assert.equal(page.shown().length, 5);

  // The drop-down scrolls on its own instead of stretching the sidebar, and a
  // hidden menu takes no room in both looks.
  for (const css of [neon, shell]) {
    assert.match(css, /\.conversation-older \{[^}]*max-height: 40vh;[^}]*overflow-y: auto;/u);
    assert.match(css, /\.conversation-older\[hidden\] \{\s*display: none;\s*\}/u);
  }
  assert.match(neon, /\.conversation-more\[aria-expanded="true"\] i \{\s*transform: rotate\(180deg\);/u);
});
