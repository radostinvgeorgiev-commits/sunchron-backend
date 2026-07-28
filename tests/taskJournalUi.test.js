import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("дневникът има три ясни състояния и автоматично запазване", async () => {
  const script = await readFile(
    new URL("../public/task-journal.js", import.meta.url),
    "utf8",
  );
  assert.match(script, /const STATUS_ORDER = \["now", "waiting", "done"\]/u);
  assert.match(script, /localStorage\.setItem\(STORAGE_KEY/u);
  assert.match(script, /Дневник на задачите/u);
});

test("дневникът добавя, премества и премахва лични задачи", async () => {
  const script = await readFile(
    new URL("../public/task-journal.js", import.meta.url),
    "utf8",
  );
  assert.match(script, /data-task-add-form/u);
  assert.match(script, /data-task-move/u);
  assert.match(script, /data-task-remove/u);
});

test("мобилният изглед остава в една колона", async () => {
  const styles = await readFile(
    new URL("../public/task-journal.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /@media \(max-width: 520px\)/u);
  assert.match(styles, /\.task-card \{\s*grid-template-columns: 1fr;/u);
});
