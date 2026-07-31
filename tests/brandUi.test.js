import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the user interface presents the AI Core brand and generated mark", async () => {
  const [html, authCss, visionCss] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/auth.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<title>AI CORE/u);
  assert.match(html, /Вход в AI CORE/u);
  assert.match(html, /src="\/ai-core-mark\.png"/u);
  assert.doesNotMatch(html, />SYNCHRON-X</u);
  assert.match(authCss, /\.auth-brand img/u);
  assert.match(visionCss, /\.brand-icon img/u);
});
