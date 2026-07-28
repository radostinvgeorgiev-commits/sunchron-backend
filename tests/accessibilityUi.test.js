import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../public/accessibility.js", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../public/accessibility.css", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);

function createHarness(storedMode = null) {
  const dom = new JSDOM(`<!doctype html>
    <html data-font-scale="max">
      <body>
        <button id="fontSizeBtn" aria-pressed="true">
          <span id="fontSizeLabel">Много едър шрифт</span>
        </button>
      </body>
    </html>`);
  const values = new Map();
  if (storedMode) values.set("synchron.ui.fontScale", storedMode);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const context = {
    document: dom.window.document,
    localStorage,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { context, dom, values };
}

test("very large text is the permanent default", () => {
  const harness = createHarness();
  const { document } = harness.dom.window;

  assert.equal(document.documentElement.dataset.fontScale, "max");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "max");
  assert.equal(
    document.getElementById("fontSizeBtn").getAttribute("aria-pressed"),
    "true",
  );
});

test("font control can switch modes and remembers the selected mode", () => {
  const harness = createHarness();
  const { document } = harness.dom.window;

  document.getElementById("fontSizeBtn").click();
  assert.equal(document.documentElement.dataset.fontScale, "standard");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "standard");

  document.getElementById("fontSizeBtn").click();
  assert.equal(document.documentElement.dataset.fontScale, "max");
  assert.equal(
    document.getElementById("fontSizeLabel").textContent,
    "Много едър шрифт",
  );
});

test("chat text is exactly three times the former 16px size", () => {
  assert.match(css, /--synchron-chat-text:\s*48px/u);
  assert.match(
    css,
    /\.message\s*\{[^}]*font-size:\s*var\(--synchron-chat-text\)\s*!important/u,
  );
});

test("accessibility assets load after the ordinary interface styles", () => {
  const modulesPosition = html.indexOf("/modules.css");
  const accessibilityPosition = html.indexOf("/accessibility.css");
  const appPosition = html.indexOf("/app.js");
  const accessibilityScriptPosition = html.indexOf("/accessibility.js");

  assert.ok(modulesPosition >= 0);
  assert.ok(accessibilityPosition > modulesPosition);
  assert.ok(accessibilityScriptPosition > appPosition);
  assert.match(html, /<html lang="bg" data-font-scale="max">/u);
});

test("mobile large-text layout keeps cards and drawers inside the viewport", () => {
  assert.match(css, /@media \(max-width: 520px\)/u);
  assert.match(css, /\.data-drawer\s*\{[^}]*width:\s*min\(720px,\s*100vw\)/u);
  assert.match(
    css,
    /\.work-center-card\s*\{[^}]*grid-template-columns:\s*58px minmax\(0,\s*1fr\)/u,
  );
});
