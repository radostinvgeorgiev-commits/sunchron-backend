import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the interface presents Novarium as the system and Novarium as its core", async () => {
  const [html, authCss, visionCss] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/auth.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<title>Novarium/u);
  assert.match(html, /Вход в Novarium/u);
  assert.match(html, /src="\/novarium-mark\.png"/u);
  assert.match(html, />Novarium</u);
  assert.match(html, /<h1 id="publicTitle">/u);
  assert.match(authCss, /\.auth-wordmark img/u);
  assert.match(visionCss, /\.brand-icon img/u);
});
