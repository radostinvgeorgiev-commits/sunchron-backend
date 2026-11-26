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

test("the work toolbar has no pet picker and keeps working", () => {
  const dom = createWorkModeDom();
  const { window } = dom;
  window.fetch = async () => {
    throw new Error("offline");
  };

  window.eval(workModeSource);
  window.SynchronWorkMode.init({ id: "no-pets-test" });
  assert.equal(window.SynchronWorkMode.openPetManager, undefined);
  window.SynchronWorkMode.openManager();
  assert.doesNotMatch(
    window.document.getElementById("dataDrawerBody").textContent,
    /любим|Кори|Искра/u,
  );
  assert.equal(
    window.SynchronWorkMode.getRequestPayload().workContext?.agent?.petId,
    undefined,
  );
});
