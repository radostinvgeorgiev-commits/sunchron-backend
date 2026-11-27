import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readPublic = (file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8");

const RULES = [
  "Разходи: сървъри, AI, такси за плащане и заплатата на управителя на фирмата.",
  "Данъци в България, без офшорни фирми.",
  "Връщане на вложеното: парите, които собственикът е вложил във фирмата, за да плаща разходите в началото, му се връщат като заем.",
  "Резерв: 10% от остатъка, докато се съберат около 3 месеца разходи.",
  "Остатъкът: 80% за каузи, които хората сами предлагат и избират в „Каузи“, и 20% за собственика.",
];

test("transparency page lists the money order and plans links to it", async () => {
  const [page, plans, server] = await Promise.all([
    readPublic("transparency.html"),
    readPublic("plans.html"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);
  for (const rule of RULES) assert.ok(page.includes(rule), rule);
  assert.match(plans, /href="\/transparency"/u);
  assert.doesNotMatch(plans, /Никой не прибира печалба/u);
  assert.match(server, /public\/transparency\.html/u);
});

test("every money rule is translated into English and the other site languages", async () => {
  const english = await readPublic("locale-en.js");
  for (const rule of RULES) {
    const line = english.split("\n").find((entry) => entry.startsWith(`${rule}|`));
    assert.ok(line, `missing English for: ${rule}`);
    const en = line.split("|")[1];
    for (const language of ["de", "es", "fr", "it", "ro"]) {
      const catalog = JSON.parse(await readPublic(`locales/${language}.json`));
      assert.ok(catalog[en], `missing ${language} for: ${en}`);
    }
  }
});
