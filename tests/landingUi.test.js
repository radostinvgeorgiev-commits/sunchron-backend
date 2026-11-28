import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
const [html, script, css, english] = await Promise.all([
  read("index.html"),
  read("landing.js"),
  read("landing.css"),
  read("locale-en.js"),
]);

test("the start page leads with the slogan, one promise and one button", () => {
  assert.match(html, /class="landing-kicker">Твоят AI\. Твоят свят\./u);
  assert.match(html, /id="publicTitle"[\s\S]{0,200}Много AI\.[\s\S]{0,120}Една памет\.[\s\S]{0,160}Твоята\./u);
  assert.match(html, /data-open-auth="start">Започни безплатно/u);
  assert.match(html, /Безплатно за начало\. Без банкова карта\./u);
  for (const id of ["how", "specialists", "prices"]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(html, /href="\/transparency"/u);
  assert.match(html, /href="\/landing\.css\?v=/u);
  assert.match(html, /src="\/landing\.js\?v=[^"]+" defer/u);
});

test("the sign-in card sits in a window that opens from the buttons", () => {
  const dialog = html.indexOf('<dialog class="landing-auth" id="authDialog"');
  const card = html.indexOf('id="authCard"');
  assert.ok(dialog > 0 && card > dialog, "the card is inside the window");
  assert.match(script, /querySelectorAll\("\[data-open-auth\]"\)/u);
  assert.match(script, /showModal/u);
  // Signing in hides the page, and the window closes with it.
  assert.match(script, /if \(gate\.hidden\) closeAuth\(\)/u);
  // Old /register links still land on the sign-in card.
  assert.match(script, /pathname === "\/register"/u);
  assert.match(css, /\.landing-auth::backdrop/u);
  assert.match(css, /prefers-reduced-motion: reduce/u);
});

test("the demo answers from the page, without any request", () => {
  // The only request on the start page is the free chapter check.
  assert.deepEqual(script.match(/fetch\("[^"]+"/gu), ['fetch("/api/free-check"']);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://novariumai.com/" });
  dom.window.HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute("open", "");
  };
  dom.window.eval(script);
  const output = dom.window.document.querySelector("[data-demo-output]");
  assert.match(output.textContent, /Спрях\./u);
  dom.window.document.querySelector('[data-demo="1"]').click();
  assert.match(output.textContent, /без захар/u);
  assert.equal(dom.window.document.querySelector('[data-demo="1"]').getAttribute("aria-checked"), "true");
  dom.window.document.querySelector('[data-open-auth="start"]').click();
  assert.ok(dom.window.document.getElementById("authDialog").hasAttribute("open"));
  dom.window.close();
});

test("every new start-page text has an English translation", () => {
  for (const text of [
    "Много AI.",
    "Една памет.",
    "Твоята.",
    "Започни безплатно",
    "Ти казваш веднъж. Аватарът помни.",
    "Твоят свят остава твой.",
    "Започваш безплатно. Плащаш само за повече.",
    "Твоят AI те чака.",
  ]) {
    assert.ok(english.includes(`\n${text}|`), text);
  }
});

test("the writer specialist is shown as new and exists in the app", async () => {
  assert.match(html, /<li class="landing-new">[\s\S]{0,120}Писател<\/strong><em>Ново<\/em>/u);
  assert.match(await readFile("src/services/assistantPresets.js", "utf8"), /id: "writer",\s*label: "Писател"/u);
});

test("after sign-in the chat area uses the same neon night", async () => {
  const neon = await read("app-neon.css");
  assert.match(html, /href="\/app-neon\.css\?v=/u);
  assert.match(neon, /#chat-container\.chatPanel[\s\S]{0,400}#05060f|var\(--nv-night\)/u);
  // Open menus inside the top bar keep their light cards and dark text.
  assert.match(neon, /\.chat-toolbar[\s\S]{0,200}:not\(\s*:is\([\s\S]{0,40}\.model-picker-menu/u);
  assert.match(neon, /\.assistant-picker/u);
});

test("the sign-in window and every window after sign-in use the neon look", async () => {
  const neon = await read("app-neon.css");
  const landing = await read("landing.css");
  assert.match(neon, /\.share-dialog \.share-card,[\s\S]{0,400}background:[\s\S]{0,200}var\(--nv-card\) !important/u);
  assert.match(neon, /:is\(\s*\.sidebar,\s*\.mobile-menu,\s*\.statusPanel,\s*\.data-drawer,\s*\.doc-panel\)/u);
  assert.match(neon, /input:not\(\[type="checkbox"\]\)[\s\S]{0,200}background: var\(--nv-field\) !important/u);
  assert.match(landing, /\.landing-auth \.auth-card \{[\s\S]{0,400}#0d0e30 !important/u);
  assert.match(landing, /\.landing-auth \.auth-card \.auth-primary \{[\s\S]{0,200}linear-gradient/u);
});

test("the free chapter check works without sign-in and shows each clash side by side", async () => {
  assert.match(html, /id="free-check"[\s\S]{0,400}Провери глава\. Без вход\./u);
  assert.match(html, /href="#free-check">Пробвай безплатно/u);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://novariumai.com/" });
  dom.window.HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute("open", "");
  };
  let sent = null;
  dom.window.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        result: { score: 88, models: 2, issues: [{ fact: "Мила има зелени очи.", quote: "кафявите си очи", why: "Очите са зелени." }] },
      }),
    };
  };
  dom.window.eval(script);
  const doc = dom.window.document;
  const form = doc.querySelector("[data-free-check]");
  form.querySelector("[name=facts]").value = "Мила има зелени очи.";
  form.querySelector("[name=text]").value = "Мила погледна с кафявите си очи.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.url, "/api/free-check");
  assert.deepEqual(sent.body, { facts: "Мила има зелени очи.", text: "Мила погледна с кафявите си очи." });
  const result = doc.querySelector("[data-free-result]");
  assert.equal(result.hidden, false);
  assert.match(result.textContent, /88\/100/u);
  assert.match(result.textContent, /В книгата: Мила има зелени очи\./u);
  assert.match(result.textContent, /Главата: „кафявите си очи“/u);
  dom.window.close();
});
