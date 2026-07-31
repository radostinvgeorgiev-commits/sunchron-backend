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
  assert.match(html, /id="workCenterBtn"/u);
  assert.match(html, /id="sidebarBackdrop"/u);
  assert.match(html, /Лична AI операционна система/u);
  assert.match(html, /Инструменти/u);
  assert.match(script, /fetch\(["']\/memory\/profile["']/u);
  assert.match(script, /fetch\(["']\/permissions["']/u);
  assert.match(script, /MEMORY_DELETE_CONFIRMATION_REQUIRED/u);
  assert.doesNotMatch(script, /x-confirm-memory-delete/u);
  assert.match(script, /elements\.imageInput\.click\(\)/u);
  assert.match(script, /function closeSidebar\(\)/u);
  assert.match(script, /function openModulesDrawer\(\)/u);
  assert.match(html, /task-journal\.js/u);
  assert.doesNotMatch(script, /function openFocusDrawer\(\)/u);
  assert.doesNotMatch(script, /Свързване на GitHub Copilot/u);
  assert.match(script, /function openToolsDrawer\(\)/u);
  assert.match(
    script,
    /<strong>Снимки<\/strong><p>JPEG, PNG и WebP до 5 MB\.<\/p>/u,
  );
  assert.doesNotMatch(script, /Снимки и файлове/u);
  assert.match(script, /fetch\(["']\/health\/integrations["']/u);
  assert.match(script, /Твоята лична AI операционна система/u);
  assert.match(script, /item\.readOnly/u);
  assert.match(script, /fetch\(["']\/health\/ready["']/u);
  assert.match(script, /markMemoryOperational\(\)/u);
  assert.match(script, /state\.opensearchFailures >= 3/u);
  assert.match(script, /Свързан · работи/u);
  assert.match(script, /Изключено · режим без Copilot/u);
  assert.match(script, /COPILOT_AUTOMATION_DISABLED/u);
  assert.match(
    script,
    /Кодовият мост е запазен, но е изключен в текущия режим без Copilot/u,
  );
  assert.doesNotMatch(script, /fetch\(["']\/opensearch-status["']/u);
  assert.match(html, /\/assets\/20260730-opensearch-status-v1\/app\.js/u);
});
