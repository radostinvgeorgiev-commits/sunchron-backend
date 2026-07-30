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

function createHarness({
  config,
  readiness = {
    status: "ready",
    checks: {
      chatAgent: { ready: true },
      memory: { ready: true, status: "green" },
    },
  },
  integrations = {
    tools: [
      {
        id: "github-read",
        enabled: true,
        executable: true,
        configured: true,
      },
      {
        id: "digitalocean-read",
        enabled: true,
        executable: true,
        configured: true,
      },
      {
        id: "cloudflare-read",
        enabled: true,
        executable: true,
        configured: false,
      },
      {
        id: "google-drive-read",
        enabled: true,
        executable: true,
        configured: true,
      },
      {
        id: "gmail-read",
        enabled: true,
        executable: true,
        configured: true,
      },
      {
        id: "google-calendar-read",
        enabled: true,
        executable: true,
        configured: true,
      },
    ],
  },
  googleConnected = false,
  githubConnected = false,
  fetchFails = false,
} = {}) {
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
    fetch: async (url) => {
      if (fetchFails) throw new Error("offline");
      const path = String(url);
      const result = path.includes("/health/ready")
        ? readiness
        : path.includes("/health/integrations")
          ? integrations
          : path.includes("/api/google/status")
            ? { connected: googleConnected }
            : path.includes("/api/github/status")
              ? { connected: githubConnected }
              : config || {};
      return {
        ok: true,
        json: async () => result,
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

test("work center uses safe GitHub links without duplicating the task journal", async () => {
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
    !hrefs.includes(
      "https://github.com/radostinvgeorgiev-commits/sunchron-backend/issues",
    ),
  );
  const journalButton = harness.dom.window.document.querySelector(
    '[data-work-center-target="focusBtn"]',
  );
  assert.equal(
    journalButton?.textContent.includes("Дневник на задачите"),
    true,
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
  const chatGptLink = [
    ...harness.dom.window.document.querySelectorAll("a"),
  ].find((link) => link.textContent.includes("ChatGPT"));

  assert.equal(chatGptLink.href, "https://chatgpt.com/");
  assert.match(chatGptLink.textContent, /Без автоматична връзка с паметта/u);
});

test("featured connected chat reports real core readiness and returns to chat", async () => {
  const harness = createHarness();
  await openCenter(harness);
  const { document } = harness.dom.window;
  const connectedChat = document.querySelector(
    '[data-work-center-target="chat"]',
  );

  assert.ok(connectedChat.classList.contains("featured"));
  assert.match(
    connectedChat.textContent,
    /AI ядро и постоянна памет: свързани/u,
  );
  connectedChat.click();
  assert.equal(document.getElementById("dataDrawer").hidden, true);
  assert.equal(document.getElementById("chatInput").value, "Незавършен текст");
});

test("connected chat never claims readiness when memory is unavailable", async () => {
  const harness = createHarness({
    readiness: {
      status: "not-ready",
      checks: {
        chatAgent: { ready: true },
        memory: { ready: false, status: "unavailable" },
      },
    },
  });
  await openCenter(harness);
  const connectedChat = harness.dom.window.document.querySelector(
    '[data-work-center-target="chat"]',
  );

  assert.match(connectedChat.textContent, /не са напълно готови/u);
  assert.doesNotMatch(connectedChat.textContent, /памет: свързани/u);
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

test("work center shows real connection state instead of claiming everything works", async () => {
  const harness = createHarness();
  await openCenter(harness);
  const text = harness.dom.window.document
    .getElementById("dataDrawerBody")
    .textContent.replace(/\s+/gu, " ");

  assert.match(text, /GitHub Read: работи/u);
  assert.match(text, /DigitalOcean Read: работи/u);
  assert.match(text, /Cloudflare Read: не е конфигуриран/u);
  assert.match(text, /Изисква еднократен вход в Google/u);
});

test("one Google login marks Drive, Gmail, and Calendar as connected", async () => {
  const harness = createHarness({ googleConnected: true });
  await openCenter(harness);
  const googleCards = ["googleDriveBtn", "gmailBtn", "googleCalendarBtn"].map(
    (target) =>
      harness.dom.window.document.querySelector(
        `[data-work-center-target="${target}"]`,
      ),
  );

  googleCards.forEach((card) => {
    assert.match(card.textContent, /Работи/u);
    assert.doesNotMatch(card.textContent, /Изисква еднократен вход/u);
  });
});

test("mobile drawer cards use full width without horizontal overflow", () => {
  assert.doesNotMatch(css, /display:none\}\\\\n\.drawer-backdrop/u);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/u);
  assert.match(
    css,
    /\.permission-card,\s*\.tool-status-card\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*flex-direction:\s*column/su,
  );
  assert.match(css, /\.data-drawer-body\s*\{[^}]*overflow-x:\s*hidden/u);
  assert.match(css, /\.work-center-card\s*\{\s*min-height:\s*104px/u);
});
