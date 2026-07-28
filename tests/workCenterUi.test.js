import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../public/work-center.js", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../public/appshell.css", import.meta.url),
  "utf8",
);

function createHarness({ config, fetchFails = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <aside id="sidebar"></aside>
    <button id="workCenterBtn">Работен център</button>
    <button id="googleDriveBtn">Drive</button>
    <button id="gmailBtn">Gmail</button>
    <button id="googleCalendarBtn">Calendar</button>
    <textarea id="chatInput">Незавършен текст</textarea>
    <div id="drawerBackdrop" hidden></div>
    <aside id="dataDrawer" hidden>
      <h2 id="dataDrawerTitle"></h2>
      <div id="dataDrawerBody"></div>
    </aside>
  </body>`);
  const context = {
    URL,
    console,
    document: dom.window.document,
    Event: dom.window.Event,
    fetch: async () => {
      if (fetchFails) throw new Error("offline");
      return {
        ok: true,
        json: async () => config || {},
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { dom, context };
}

async function openCenter(harness) {
  harness.dom.window.document.getElementById("workCenterBtn").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("work center opens, closes, and preserves unfinished chat text", async () => {
  const harness = createHarness();
  await openCenter(harness);
  const { document } = harness.dom.window;

  assert.equal(document.getElementById("dataDrawer").hidden, false);
  assert.equal(
    document.getElementById("dataDrawerTitle").textContent,
    "Работен център",
  );
  assert.equal(document.getElementById("chatInput").value, "Незавършен текст");

  document.querySelector("[data-close-work-center]").click();
  assert.equal(document.getElementById("dataDrawer").hidden, true);
  assert.equal(document.getElementById("drawerBackdrop").hidden, true);
  assert.equal(document.getElementById("chatInput").value, "Незавършен текст");
});

test("external cards use exact GitHub URLs and safe link attributes", async () => {
  const harness = createHarness({
    config: {
      chatgptWorkUrl: "https://chatgpt.com/g/example",
      digitalOceanUrl: "https://cloud.digitalocean.com/",
      cloudflareUrl: "https://dash.cloudflare.com/",
    },
  });
  await openCenter(harness);
  const links = [...harness.dom.window.document.querySelectorAll("a")];
  const hrefs = links.map((link) => link.href);

  assert.ok(
    hrefs.includes(
      "https://github.com/radostinvgeorgiev-commits/sunchron-backend",
    ),
  );
  assert.ok(
    hrefs.includes(
      "https://github.com/radostinvgeorgiev-commits/sunchron-backend/issues",
    ),
  );
  assert.ok(
    hrefs.includes(
      "https://github.com/radostinvgeorgiev-commits/sunchron-backend/pulls",
    ),
  );
  assert.ok(
    hrefs.includes(
      "https://github.com/radostinvgeorgiev-commits/sunchron-backend/actions",
    ),
  );
  links.forEach((link) => {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  });
});

test("ChatGPT falls back safely when public config is unavailable", async () => {
  const harness = createHarness({ fetchFails: true });
  await openCenter(harness);
  const firstLink = harness.dom.window.document.querySelector(
    ".work-center-card.featured",
  );

  assert.equal(firstLink.href, "https://chatgpt.com/");
  assert.match(firstLink.textContent, /Може да изисква вход/u);
});

test("Google cards reuse the existing hidden integration actions", async () => {
  const harness = createHarness();
  const { document } = harness.dom.window;
  const clicks = [];
  ["googleDriveBtn", "gmailBtn", "googleCalendarBtn"].forEach((id) => {
    document
      .getElementById(id)
      .addEventListener("click", () => clicks.push(id));
  });
  await openCenter(harness);

  document.querySelector('[data-work-center-target="googleDriveBtn"]').click();
  document.querySelector('[data-work-center-target="gmailBtn"]').click();
  document
    .querySelector('[data-work-center-target="googleCalendarBtn"]')
    .click();

  assert.deepEqual(clicks, ["googleDriveBtn", "gmailBtn", "googleCalendarBtn"]);
});

test("mobile drawer cards use full width without horizontal overflow", () => {
  assert.doesNotMatch(css, /display:none\}\\\\n\.drawer-backdrop/u);
  assert.match(css, /@media\(max-width:520px\)/u);
  assert.match(
    css,
    /\.permission-card,\.tool-status-card\{width:100%;min-width:0;flex-direction:column/u,
  );
  assert.match(css, /\.data-drawer-body\{[^}]*overflow-x:hidden/u);
  assert.match(css, /\.work-center-card\{min-height:104px/u);
});
