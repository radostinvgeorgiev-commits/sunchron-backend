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
    <html data-font-scale="standard">
      <body></body>
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

test("standard text is the default for new users", () => {
  const harness = createHarness();
  const { document } = harness.dom.window;

  assert.equal(document.documentElement.dataset.fontScale, "standard");
  assert.equal(document.documentElement.dataset.fontLevel, "standard");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "standard");
});

test("programmatic increase and decrease change one level and remember it", () => {
  const harness = createHarness("max");
  const { document } = harness.dom.window;
  const api = harness.context.SynchronAccessibility;

  api.increase();
  assert.equal(document.documentElement.dataset.fontScale, "max");
  assert.equal(document.documentElement.dataset.fontLevel, "ultra");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "ultra");

  api.decrease();
  assert.equal(document.documentElement.dataset.fontLevel, "max");
  api.decrease();
  assert.equal(document.documentElement.dataset.fontLevel, "large");
  assert.equal(harness.values.get("synchron.ui.fontScale"), "large");
});

test("saved level is restored without visible controls", () => {
  const harness = createHarness("standard");
  const { document } = harness.dom.window;

  assert.equal(document.documentElement.dataset.fontScale, "standard");
  assert.equal(document.documentElement.dataset.fontLevel, "standard");

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

test("accessibility assets load and public UI has no font-size controls", () => {
  const appShellPosition = html.indexOf("/appshell.css");
  const accessibilityPosition = html.indexOf("/accessibility.css");
  const appPosition = html.indexOf("/app.js");
  const accessibilityScriptPosition = html.indexOf("/accessibility.js");

  assert.ok(appShellPosition >= 0);
  assert.ok(accessibilityPosition > appShellPosition);
  assert.ok(accessibilityScriptPosition > appPosition);
  assert.match(html, /<html lang="bg" data-font-scale="standard">/u);
  assert.doesNotMatch(html, /id="fontSizeDecreaseBtn"/u);
  assert.doesNotMatch(html, /id="fontSizeIncreaseBtn"/u);
  assert.doesNotMatch(html, /id="fontSizeLabel"/u);
  assert.doesNotMatch(html, /class="font-size-control"/u);
  assert.doesNotMatch(html, /aria-label="Размер на текста"/u);
});

test("mobile large-text layout keeps cards and drawers inside the viewport", () => {
  assert.match(css, /@media \(max-width: 520px\)/u);
  assert.match(css, /\.data-drawer\s*\{[^}]*width:\s*min\(720px,\s*100vw\)/u);
  assert.match(
    css,
    /\.work-center-card\s*\{[^}]*grid-template-columns:\s*58px minmax\(0,\s*1fr\)/u,
  );
});
