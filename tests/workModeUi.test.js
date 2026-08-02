import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

function createWorkModeDom(script, fetchImpl) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <input id="chatInput">
      <button id="chatModeBtn"></button>
      <button id="workModeToolbarBtn"></button>
      <button id="workModeBtn"></button>
      <button id="workPetBtn"><span id="workPet"></span></button>
      <button id="workContextBtn"><strong id="workProjectLabel"></strong><small id="workAgentLabel"></small></button>
      <aside id="dataDrawer" hidden><h2 id="dataDrawerTitle"></h2><div id="dataDrawerBody"></div></aside>
      <div id="drawerBackdrop" hidden></div>
      <nav id="sidebar"></nav><div id="sidebarBackdrop" hidden></div>
      <nav class="mobile-command-bar"><button data-command="chat"></button><button data-command="work"></button></nav>
    </body>`,
    { runScripts: "dangerously", url: "https://synchron.foundation/" },
  );
  if (fetchImpl) dom.window.fetch = fetchImpl;
  dom.window.eval(script);
  return dom;
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Chat and Work are available with projects, agents, and pet state", async () => {
  const [html, css, workMode, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/work-mode.css", import.meta.url), "utf8"),
    readFile(new URL("../public/work-mode.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="chatModeBtn"/u);
  assert.match(html, /id="workModeToolbarBtn"/u);
  assert.match(html, /id="workPetBtn"/u);
  assert.match(html, /id="workContextBtn"/u);
  assert.match(html, /id="workPet"/u);
  assert.match(html, /\/work-mode\.js\?v=/u);
  assert.ok(
    html.indexOf("/work-mode.js") <
      html.indexOf("/assets/20260801-profile-actions/app.js"),
  );
  assert.doesNotMatch(
    html.match(/<button[^>]+id="workModeBtn"[^>]*>/u)?.[0] || "",
    /data-owner-only/u,
  );

  assert.match(css, /data-pet-state="running"/u);
  assert.match(css, /data-pet-state="needs-input"/u);
  assert.match(css, /data-pet-state="blocked"/u);
  assert.match(css, /\.work-pet-button/u);
  assert.match(css, /prefers-reduced-motion/u);

  assert.match(workMode, /function getRequestPayload/u);
  assert.match(workMode, /function createProjectForm/u);
  assert.match(workMode, /function createAgentForm/u);
  assert.match(workMode, /function createEditAgentForm/u);
  assert.match(workMode, /Личният любимец/u);
  assert.match(workMode, /label: "Кори"/u);
  assert.match(workMode, /label: "Капка"/u);
  assert.match(workMode, /label: "Искра"/u);
  assert.match(workMode, /label: "Бухал"/u);
  assert.match(workMode, /label: "Скала"/u);
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
  assert.match(
    script,
    /model: Object\.hasOwn\(MODEL_OPTIONS, agent\?\.model\)/u,
  );
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
      <button id="workPetBtn"><span id="workPet"></span></button>
      <button id="workContextBtn"><strong id="workProjectLabel"></strong><small id="workAgentLabel"></small></button>
      <aside id="dataDrawer" hidden><h2 id="dataDrawerTitle"></h2><div id="dataDrawerBody"></div></aside>
      <div id="drawerBackdrop" hidden></div>
      <nav id="sidebar"></nav><div id="sidebarBackdrop" hidden></div>
      <nav class="mobile-command-bar"><button data-command="chat"></button><button data-command="work"></button></nav>
    </body>`,
    { runScripts: "dangerously", url: "https://synchron.foundation/" },
  );

  dom.window.eval(script);
  dom.window.SynchronWorkMode.init({ id: "tester-one", role: "tester" });
  dom.window.document.getElementById("workPetBtn").click();
  assert.equal(
    dom.window.document.getElementById("dataDrawerTitle").textContent,
    "Избери любимец",
  );
  assert.ok(dom.window.document.querySelector('[aria-label="Избери Бухал"]'));
  assert.doesNotMatch(
    dom.window.document.getElementById("dataDrawerBody").textContent,
    /Проекти|Лични агенти/u,
  );
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

  dom.window.SynchronWorkMode.openManager();
  const agentForm = dom.window.document.querySelectorAll("form")[1];
  agentForm.querySelector("input").value = "Тестов ръководител";
  agentForm.querySelector("#newWorkAgentRole").value = "organizer";
  agentForm.querySelector("#newWorkAgentModel").value = "gpt-5.6-sol";
  agentForm.querySelector("textarea").value = "Води проверимите етапи";
  agentForm.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );

  const agentPayload = dom.window.SynchronWorkMode.getRequestPayload();
  assert.equal(agentPayload.workContext.agent.name, "Тестов ръководител");
  assert.equal(agentPayload.workContext.agent.model, "gpt-5.6-sol");

  const editAgent = [...dom.window.document.querySelectorAll("button")].find(
    (button) =>
      button.getAttribute("aria-label") === "Редактирай Тестов ръководител",
  );
  assert.ok(editAgent);
  editAgent.click();
  const editForm = dom.window.document.querySelector(".work-agent-edit-form");
  editForm.querySelector("#editWorkAgentName").value = "Обновен ръководител";
  editForm.querySelector("#editWorkAgentRole").value = "builder";
  editForm.querySelector("#editWorkAgentModel").value = "gpt-5.6-terra";
  editForm.querySelector("#editWorkAgentPurpose").value =
    "Строи и проверява резултата";
  editForm.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );

  const editedPayload = dom.window.SynchronWorkMode.getRequestPayload();
  assert.equal(editedPayload.workContext.agent.name, "Обновен ръководител");
  assert.equal(editedPayload.workContext.agent.role, "builder");
  assert.equal(editedPayload.workContext.agent.model, "gpt-5.6-terra");
  assert.equal(
    editedPayload.workContext.agent.purpose,
    "Строи и проверява резултата",
  );
  assert.match(
    dom.window.document.getElementById("dataDrawerBody").textContent,
    /Агентът „Обновен ръководител“ е обновен и избран/u,
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

  dom.window.SynchronWorkMode.openManager();
  const sparkPet = dom.window.document.querySelector(
    '[aria-label="Избери Искра"]',
  );
  assert.ok(sparkPet);
  sparkPet.click();
  assert.equal(dom.window.document.getElementById("workPet").textContent, "🔥");
  assert.equal(
    dom.window.document.getElementById("workPet").dataset.petId,
    "spark",
  );
  assert.match(
    dom.window.localStorage.getItem("synchronWorkMode:tester-one"),
    /"petId":"spark"/u,
  );
  dom.window.close();
});

test("a late workspace read cannot erase a project created during startup", async () => {
  const script = await readFile(
    new URL("../public/work-mode.js", import.meta.url),
    "utf8",
  );
  let resolveWorkspaceRead;
  const workspaceRead = new Promise((resolve) => {
    resolveWorkspaceRead = resolve;
  });
  const savedStates = [];
  const dom = createWorkModeDom(script, (url, options = {}) => {
    if (options.method === "PUT") {
      const state = JSON.parse(options.body).state;
      savedStates.push(state);
      return Promise.resolve({
        ok: true,
        json: async () => ({ state }),
      });
    }
    return workspaceRead;
  });

  dom.window.SynchronWorkMode.init({ id: "race-tester", role: "tester" });
  dom.window.document.getElementById("workModeToolbarBtn").click();
  dom.window.SynchronWorkMode.openManager();
  const projectForm = dom.window.document.querySelectorAll("form")[0];
  projectForm.querySelector("input").value = "Неподлежащо на загуба";
  projectForm.querySelector("textarea").value = "Запази локалната промяна";
  projectForm.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );

  resolveWorkspaceRead({
    ok: true,
    json: async () => ({
      persisted: true,
      state: {
        mode: "chat",
        projects: [{ id: "old", name: "Стар сървърен проект" }],
        agents: [{ id: "old-agent", name: "Стар агент" }],
      },
    }),
  });
  await nextTurn();
  await nextTurn();

  assert.equal(
    dom.window.SynchronWorkMode.getRequestPayload().workContext.project.name,
    "Неподлежащо на загуба",
  );
  assert.ok(
    savedStates.some((state) =>
      state.projects.some(
        (project) => project.name === "Неподлежащо на загуба",
      ),
    ),
  );
  assert.match(
    dom.window.document.getElementById("dataDrawerBody").textContent,
    /Проектът „Неподлежащо на загуба“ е създаден и избран/u,
  );
  dom.window.close();
});

test("a pending local project survives reload and replaces stale remote state", async () => {
  const script = await readFile(
    new URL("../public/work-mode.js", import.meta.url),
    "utf8",
  );
  const oldRemoteState = {
    mode: "work",
    activeProjectId: "old",
    activeAgentId: "old-agent",
    projects: [{ id: "old", name: "Стар сървърен проект" }],
    agents: [{ id: "old-agent", name: "Стар агент" }],
  };
  const firstDom = createWorkModeDom(script, (url, options = {}) => {
    if (options.method === "PUT") {
      return Promise.resolve({
        ok: false,
        json: async () => ({ error: "Временно недостъпно" }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ persisted: true, state: oldRemoteState }),
    });
  });
  firstDom.window.SynchronWorkMode.init({ id: "reload-tester" });
  await nextTurn();
  firstDom.window.document.getElementById("workModeToolbarBtn").click();
  firstDom.window.SynchronWorkMode.openManager();
  const projectForm = firstDom.window.document.querySelectorAll("form")[0];
  projectForm.querySelector("input").value = "Локален проект";
  projectForm.querySelector("textarea").value = "Чака синхронизация";
  projectForm.dispatchEvent(
    new firstDom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const localState = firstDom.window.localStorage.getItem(
    "synchronWorkMode:reload-tester",
  );
  const pending = firstDom.window.localStorage.getItem(
    "synchronWorkMode:reload-tester:pending",
  );
  assert.equal(pending, "1");
  firstDom.window.close();

  const savedStates = [];
  const secondDom = createWorkModeDom(script, (url, options = {}) => {
    if (options.method === "PUT") {
      const state = JSON.parse(options.body).state;
      savedStates.push(state);
      return Promise.resolve({ ok: true, json: async () => ({ state }) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ persisted: true, state: oldRemoteState }),
    });
  });
  secondDom.window.localStorage.setItem(
    "synchronWorkMode:reload-tester",
    localState,
  );
  secondDom.window.localStorage.setItem(
    "synchronWorkMode:reload-tester:pending",
    pending,
  );
  secondDom.window.SynchronWorkMode.init({ id: "reload-tester" });
  await nextTurn();
  await nextTurn();

  assert.ok(
    savedStates.some((state) =>
      state.projects.some((project) => project.name === "Локален проект"),
    ),
  );
  assert.equal(
    secondDom.window.localStorage.getItem(
      "synchronWorkMode:reload-tester:pending",
    ),
    null,
  );
  secondDom.window.close();
});
