import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const workModeSource = await readFile(
  new URL("../public/work-mode.js", import.meta.url),
  "utf8",
);

function createWorkModeDom() {
  return new JSDOM(
    `<!doctype html>
      <body>
        <textarea id="chatInput"></textarea>
        <button id="chatModeBtn"></button>
        <button id="workModeToolbarBtn"></button>
        <button id="workModeBtn"></button>
        <button id="workPetBtn"><span id="workPet"></span></button>
        <button id="workContextBtn"></button>
        <span id="workProjectLabel"></span>
        <span id="workAgentLabel"></span>
        <aside id="dataDrawer" hidden></aside>
        <div id="drawerBackdrop" hidden></div>
        <h2 id="dataDrawerTitle"></h2>
        <div id="dataDrawerBody"></div>
        <aside id="sidebar"></aside>
        <div id="sidebarBackdrop" hidden></div>
        <nav class="mobile-command-bar"></nav>
      </body>`,
    { runScripts: "outside-only", url: "https://example.test/" },
  );
}

test("avatar picker updates the toolbar, active agent, and local state", () => {
  const dom = createWorkModeDom();
  const { window } = dom;
  window.fetch = async () => {
    throw new Error("offline");
  };

  window.eval(workModeSource);
  window.SynchronWorkMode.init({ id: "avatar-picker-test" });
  window.document.getElementById("workPetBtn").click();

  const sparkChoice = window.document.querySelector(
    '.pet-choice[aria-label="Избери Искра"]',
  );
  assert.ok(sparkChoice);
  sparkChoice.click();

  assert.equal(window.document.getElementById("workPet").textContent, "🔥");
  assert.equal(
    window.document.getElementById("workPet").dataset.petId,
    "spark",
  );
  const selectedSparkChoice = window.document.querySelector(
    '.pet-choice[aria-label="Избери Искра"]',
  );
  assert.equal(selectedSparkChoice.classList.contains("active"), true);

  const savedState = JSON.parse(
    window.localStorage.getItem("synchronWorkMode:avatar-picker-test"),
  );
  assert.equal(savedState.petId, "spark");
  assert.equal(
    savedState.agents.find((agent) => agent.id === savedState.activeAgentId)
      .petId,
    "spark",
  );
});
