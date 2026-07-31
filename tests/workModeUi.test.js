import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("Chat and Work are available with projects, agents, and pet state", async () => {
  const [html, css, workMode, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/work-mode.css", import.meta.url), "utf8"),
    readFile(new URL("../public/work-mode.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="chatModeBtn"/u);
  assert.match(html, /id="workModeToolbarBtn"/u);
  assert.match(html, /id="workContextBtn"/u);
  assert.match(html, /id="workPet"/u);
  assert.match(html, /\/work-mode\.js\?v=/u);
  assert.ok(
    html.indexOf("/work-mode.js") <
      html.indexOf("/assets/20260730-opensearch-status-v1/app.js"),
  );
  assert.doesNotMatch(
    html.match(/<button[^>]+id="workModeBtn"[^>]*>/u)?.[0] || "",
    /data-owner-only/u,
  );

  assert.match(css, /data-pet-state="running"/u);
  assert.match(css, /data-pet-state="needs-input"/u);
  assert.match(css, /data-pet-state="blocked"/u);
  assert.match(css, /prefers-reduced-motion/u);

  assert.match(workMode, /function getRequestPayload/u);
  assert.match(workMode, /function createProjectForm/u);
  assert.match(workMode, /function createAgentForm/u);
  assert.match(workMode, /Любимецът показва/u);
  assert.match(workMode, /\/api\/workspaces/u);
  assert.match(workMode, /защитения ти профил/u);
  assert.match(workMode, /function recordActivity/u);

  assert.match(app, /SynchronWorkMode\?\.getRequestPayload/u);
  assert.match(app, /SynchronWorkMode\?\.onTask/u);
  assert.match(app, /SynchronWorkMode\?\.onDone/u);
  assert.match(app, /SynchronWorkMode\?\.onError/u);
});

test("work settings are scoped by authenticated user and payload is bounded", async () => {
  const script = await readFile(
    new URL("../public/work-mode.js", import.meta.url),
    "utf8",
  );

  assert.match(script, /synchronWorkMode:\$\{identity \|\| "anonymous"\}/u);
  assert.match(script, /\.slice\(0, 20\)/u);
  assert.match(script, /\.slice\(0, 12\)/u);
  assert.match(script, /name: cleanText\(project\?\.name, 80\)/u);
  assert.match(script, /purpose: cleanText\(agent\?\.purpose, 400\)/u);
  assert.match(script, /if \(busy && workState\?\.mode === "work"\)/u);
});

test("work mode runs in the browser and creates an isolated project payload", async () => {
  const script = await readFile(
    new URL("../public/work-mode.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<!doctype html><body>
      <input id="chatInput">
      <button id="chatModeBtn"></button>
      <button id="workModeToolbarBtn"></button>
      <button id="workModeBtn"></button>
      <button id="workContextBtn"><strong id="workProjectLabel"></strong><small id="workAgentLabel"></small><span id="workPet"></span></button>
      <aside id="dataDrawer" hidden><h2 id="dataDrawerTitle"></h2><div id="dataDrawerBody"></div></aside>
      <div id="drawerBackdrop" hidden></div>
      <nav id="sidebar"></nav><div id="sidebarBackdrop" hidden></div>
      <nav class="mobile-command-bar"><button data-command="chat"></button><button data-command="work"></button></nav>
    </body>`,
    { runScripts: "dangerously", url: "https://synchron.foundation/" },
  );

  dom.window.eval(script);
  dom.window.SynchronWorkMode.init({ id: "tester-one", role: "tester" });
  dom.window.document.getElementById("workModeToolbarBtn").click();
  dom.window.SynchronWorkMode.openManager();

  const projectForm = dom.window.document.querySelectorAll("form")[0];
  projectForm.querySelector("input").value = "Тестов проект";
  projectForm.querySelector("textarea").value = "Готов резултат";
  projectForm.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );

  const payload = dom.window.SynchronWorkMode.getRequestPayload();
  assert.equal(payload.mode, "work");
  assert.equal(payload.workContext.project.name, "Тестов проект");
  assert.equal(payload.workContext.project.objective, "Готов резултат");
  assert.match(
    dom.window.localStorage.getItem("synchronWorkMode:tester-one"),
    /Тестов проект/u,
  );

  dom.window.SynchronWorkMode.setBusy(true);
  assert.equal(
    dom.window.document.getElementById("workPet").dataset.petState,
    "running",
  );
  dom.window.SynchronWorkMode.onTask({ status: "waiting_confirmation" });
  assert.equal(
    dom.window.document.getElementById("workPet").dataset.petState,
    "needs-input",
  );
  dom.window.close();
});
