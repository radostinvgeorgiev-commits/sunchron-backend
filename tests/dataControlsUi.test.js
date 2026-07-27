import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("application exposes working memory and permission controls", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="memoryBtn"/u);
  assert.match(html, /id="permissionsBtn"/u);
  assert.match(html, /id="dataDrawer"/u);
  assert.match(html, /id="imagesBtn"/u);
  assert.match(html, /id="modulesBtn"/u);
  assert.match(html, /id="focusBtn"/u);
  assert.match(html, /id="toolsBtn"/u);
  assert.match(html, /id="sidebarBackdrop"/u);
  assert.match(html, /Лична AI операционна система/u);
  assert.match(html, /Инструменти/u);
  assert.match(script, /fetch\(["']\/memory\/profile["']/u);
  assert.match(script, /fetch\(["']\/permissions["']/u);
  assert.match(script, /x-confirm-memory-delete/u);
  assert.match(script, /elements\.imageInput\.click\(\)/u);
  assert.match(script, /function closeSidebar\(\)/u);
  assert.match(script, /function openModulesDrawer\(\)/u);
  assert.match(script, /function openFocusDrawer\(\)/u);
  assert.match(script, /function openToolsDrawer\(\)/u);
  assert.match(script, /fetch\(["']\/health\/integrations["']/u);
  assert.match(script, /Твоята лична AI операционна система/u);
  assert.match(script, /item\.readOnly/u);
});
