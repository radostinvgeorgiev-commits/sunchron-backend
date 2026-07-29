import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the personal AI interface keeps chat primary and exposes four mobile commands", async () => {
  const [html, css, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /class="mobile-command-bar"/u);
  assert.match(html, /data-command="chat"/u);
  assert.match(html, /data-command="memory"/u);
  assert.match(html, /data-command="tasks"/u);
  assert.match(html, /data-command="connections"/u);
  assert.match(css, /\.mobile-command-bar/u);
  assert.match(css, /bottom:\s*calc\(70px \+ env\(safe-area-inset-bottom\)\)/u);
  assert.match(script, /forwardClick\("memoryBtn", "memory"\)/u);
  assert.match(script, /forwardClick\("focusBtn", "tasks"\)/u);
  assert.match(script, /forwardClick\("toolsBtn", "connections"\)/u);
});

test("the visual layer preserves the readable text controls and safe drawers", async () => {
  const css = await readFile(
    new URL("../public/synchron-vision.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /\.font-size-control/u);
  assert.match(css, /\.data-drawer/u);
  assert.match(css, /width:\s*100vw\s*!important/u);
  assert.match(css, /prefers-reduced-motion/u);
});
