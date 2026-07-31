import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(
  new URL("../public/task-journal.js", import.meta.url),
  "utf8",
);

function createHarness({ tasks, version } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <button id="focusBtn"></button>
      <aside id="dataDrawer" hidden></aside>
      <div id="drawerBackdrop" hidden></div>
      <h2 id="dataDrawerTitle"></h2>
      <main id="dataDrawerBody"></main>
      <nav id="sidebar"></nav>
    </body>`,
    { url: "https://synchron.foundation", runScripts: "outside-only" },
  );
  if (tasks !== undefined) {
    dom.window.localStorage.setItem(
      "synchronTaskJournalV1",
      JSON.stringify(tasks),
    );
  }
  if (version !== undefined) {
    dom.window.localStorage.setItem(
      "synchronTaskJournalRoadmapVersion",
      String(version),
    );
  }
  dom.window.eval(script);
  return dom;
}

test("дневникът има три ясни състояния и автоматично запазване", async () => {
  assert.match(script, /const STATUS_ORDER = \["now", "waiting", "done"\]/u);
  assert.match(script, /persistTasks/u);
  assert.match(script, /Дневник на задачите/u);
});

test("дневникът добавя, премества и премахва лични задачи", async () => {
  assert.match(script, /data-task-add-form/u);
  assert.match(script, /data-task-move/u);
  assert.match(script, /data-task-remove/u);
});

test("старият roadmap се обновява без загуба на личните задачи", () => {
  const personalTask = {
    id: "task-personal",
    title: "Лична задача",
    detail: "Да остане непроменена.",
    status: "now",
    priority: "Моя",
  };
  const dom = createHarness({
    tasks: [
      {
        id: "memory-real-data",
        title: "Стар тест на паметта",
        detail: "Остаряло",
        status: "now",
        priority: "Старо",
      },
      personalTask,
    ],
    version: 2,
  });
  const migrated = JSON.parse(
    dom.window.localStorage.getItem("synchronTaskJournalV1"),
  );

  assert.deepEqual(
    migrated.find((task) => task.id === personalTask.id),
    personalTask,
  );
  assert.equal(
    migrated.find((task) => task.id === "memory-real-data").status,
    "done",
  );
  assert.equal(
    migrated.find((task) => task.id === "autonomous-delivery").status,
    "now",
  );
  assert.equal(
    migrated.find((task) => task.id === "opensearch-backup").status,
    "done",
  );
  assert.equal(
    migrated.find((task) => task.id === "tester-registration").status,
    "now",
  );
  assert.equal(
    dom.window.localStorage.getItem("synchronTaskJournalRoadmapVersion"),
    "3",
  );
});

test("нова инсталация записва актуалния roadmap", () => {
  const dom = createHarness();
  const tasks = JSON.parse(
    dom.window.localStorage.getItem("synchronTaskJournalV1"),
  );

  assert.equal(
    tasks.some((task) => task.id === "calendar-reminders"),
    true,
  );
  assert.equal(
    tasks.some((task) => task.id === "autonomous-delivery"),
    true,
  );
  assert.equal(
    tasks.find((task) => task.id === "opensearch-backup").status,
    "done",
  );
  assert.equal(
    tasks.find((task) => task.id === "tester-registration").status,
    "now",
  );
  assert.equal(dom.window.SynchronTaskJournal.roadmapVersion, 3);
});

test("мобилният изглед остава в една колона", async () => {
  const styles = await readFile(
    new URL("../public/task-journal.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /@media \(max-width: 520px\)/u);
  assert.match(styles, /\.task-card \{\s*grid-template-columns: 1fr;/u);
});
