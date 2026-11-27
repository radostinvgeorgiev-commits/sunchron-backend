import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readPublic = (file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8");

test("cookies and data deletion pages are served and linked", async () => {
  const [server, privacy, terms, help] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readPublic("privacy.html"),
    readPublic("terms.html"),
    readPublic("help.html"),
  ]);
  assert.match(server, /public\/cookies\.html/u);
  assert.match(server, /public\/data-deletion\.html/u);
  for (const page of [privacy, terms]) {
    assert.match(page, /href="\/cookies"/u);
    assert.match(page, /href="\/data-deletion"/u);
  }
  assert.match(help, /href="\/data-deletion"/u);
});

test("every visible sentence on the new legal pages is translated", async () => {
  const english = new Map(
    (await readPublic("locale-en.js"))
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|")),
  );
  const catalogs = await Promise.all(
    ["de", "es", "fr", "it", "ro"].map(async (language) =>
      JSON.parse(await readPublic(`locales/${language}.json`)),
    ),
  );
  for (const file of ["cookies.html", "data-deletion.html"]) {
    const html = (await readPublic(file))
      .replace(/<script[\s\S]*?<\/script>/gu, "")
      .replace(/<code>[\s\S]*?<\/code>/gu, "");
    const texts = html
      .split(/<[^>]+>/u)
      .map((part) => part.replace(/\s+/gu, " ").trim())
      .filter((part) => /[А-Яа-я]/u.test(part) && part !== "СИНХРОН Х ЕООД");
    for (const text of texts) {
      const en = english.get(text);
      assert.ok(en, `${file}: missing English for “${text}”`);
      for (const catalog of catalogs) assert.ok(catalog[en], `${file}: missing translation for “${en}”`);
    }
  }
});
