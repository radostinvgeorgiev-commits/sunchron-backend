import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../public/modules.js", import.meta.url),
  "utf8",
);

test("личната AI операционна система показва точно 12 работни области", () => {
  const ids = [...source.matchAll(/^\s+id: ["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
});

test("външните действия пазят изричното потвърждение", () => {
  assert.match(source, /Не прави резервация без изрично потвърждение/);
  assert.match(source, /Не публикувай нищо без изрично потвърждение/);
  assert.match(source, /Не създавай външно напомняне без потвърждение/);
});

test("работните области използват съществуващите Drive, Calendar, memory и image входове", () => {
  for (const id of [
    "memoryBtn",
    "imageInput",
    "googleCalendarBtn",
    "googleDriveBtn",
  ]) {
    assert.match(source, new RegExp(id));
  }
});
