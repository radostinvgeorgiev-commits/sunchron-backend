import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the personal AI interface keeps chat primary and exposes four mobile commands", async () => {
  const [html, css, script, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /\/assets\/20260730-v2\/synchron-vision\.css/u);
  assert.match(html, /\/assets\/20260730-v2\/synchron-vision\.js/u);
  assert.match(server, /mobileLayoutAssetVersion = "20260730-v2"/u);
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

test("mobile chat content clears the measured composer and command bar", async () => {
  const [css, script, app] = await Promise.all([
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--sx-mobile-occupied-height/u);
  assert.match(css, /scroll-padding-bottom/u);
  assert.match(css, /#chatMessages::after/u);
  assert.match(script, /ResizeObserver/u);
  assert.match(script, /composerRect\.height/u);
  assert.match(script, /commandBarRect\.height/u);
  assert.match(script, /chatMessages\.scrollTop = chatMessages\.scrollHeight/u);
  assert.match(css, /user-select:\s*text/u);
  assert.match(app, /class="action-label">Копирай<\/span>/u);
});

test("the chat shows live autonomous task progress", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
  ]);

  assert.match(script, /parsed\.event === "task"/u);
  assert.match(script, /updateTaskIndicator\(parsed\.data\)/u);
  assert.match(script, /Задачата е изпълнена и проверена/u);
  assert.match(css, /data-task-status="waiting_confirmation"/u);
});
