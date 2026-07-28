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
        <button id="fontSizeDecreaseBtn">Намали</button>
        <output id="fontSizeLabel">Много едър · 48 px</output>
        <button id="fontSizeIncreaseBtn">Увеличи</button>
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
  assert.equal(document.documentElement.dataset.fontLevel, "max");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "max");
  assert.equal(
    document.getElementById("fontSizeLabel").textContent,
    "Много едър · 48 px",
  );
});

test("plus and minus controls change one level and remember it", () => {
  const harness = createHarness();
  const { document } = harness.dom.window;
  const decrease = document.getElementById("fontSizeDecreaseBtn");
  const increase = document.getElementById("fontSizeIncreaseBtn");

  increase.click();
  assert.equal(document.documentElement.dataset.fontScale, "max");
  assert.equal(document.documentElement.dataset.fontLevel, "ultra");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "ultra");
  assert.equal(
    document.getElementById("fontSizeLabel").textContent,
    "Огромен · 60 px",
  );
  assert.equal(increase.disabled, true);

  decrease.click();
  assert.equal(document.documentElement.dataset.fontLevel, "max");
  decrease.click();
  assert.equal(document.documentElement.dataset.fontLevel, "large");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "large");
});

test("saved level is restored and controls stop at the safe limits", () => {
  const harness = createHarness("standard");
  const { document } = harness.dom.window;
  const decrease = document.getElementById("fontSizeDecreaseBtn");

  assert.equal(document.documentElement.dataset.fontScale, "standard");
  assert.equal(document.documentElement.dataset.fontLevel, "standard");
  assert.equal(decrease.disabled, true);
  assert.equal(
    document.getElementById("fontSizeLabel").textContent,
    "Обикновен · 16 px",
  );

  harness.context.SynchronAccessibility.increase();
  assert.equal(document.documentElement.dataset.fontScale, "max");
  assert.equal(document.documentElement.dataset.fontLevel, "large");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "large");
});

test("chat offers four readable sizes including 48px and 60px", () => {
  assert.match(
    css,
    /data-font-level="large"[^}]*--synchron-chat-text:\s*32px/u,
  );
  assert.match(css, /--synchron-chat-text:\s*48px/u);
  assert.match(
    css,
    /data-font-level="ultra"[^}]*--synchron-chat-text:\s*60px/u,
  );
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
  assert.match(html, /id="fontSizeDecreaseBtn"/u);
  assert.match(html, /id="fontSizeIncreaseBtn"/u);
});

test("mobile large-text layout keeps cards and drawers inside the viewport", () => {
  assert.match(css, /@media \(max-width: 520px\)/u);
  assert.match(css, /\.data-drawer\s*\{[^}]*width:\s*min\(720px,\s*100vw\)/u);
  assert.match(
    css,
    /\.work-center-card\s*\{[^}]*grid-template-columns:\s*58px minmax\(0,\s*1fr\)/u,
  );
});
