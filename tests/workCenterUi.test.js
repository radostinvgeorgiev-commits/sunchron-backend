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
const accessibilityCss = await readFile(
  new URL("../public/accessibility.css", import.meta.url),
  "utf8",
);
const mobileCommandSource = await readFile(
  new URL("../public/synchron-vision.js", import.meta.url),
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
  testerAuth = { configured: false, registrationEnabled: false },
  publicDomain = { configured: false, domain: "www.synchron.foundation" },
  tasks = [],
  workspace = null,
  audit = [],
  memories = [],
  fetchFails = false,
  testerPrepareResponse = null,
  domainPrepareResponse = null,
  domainConfirmResponse = null,
} = {}) {
  const domainRequests = [];
  const dom = new JSDOM(`<!doctype html><body>
    <aside id="sidebar"></aside>
    <button id="workCenterBtn">Работен център</button>
    <button id="toolsBtn">Инструменти</button>
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
    navigator: {
      clipboard: {
        writeText: async (value) => {
          dom.window.document.body.dataset.copiedText = value;
        },
      },
    },
    location: {
      origin: "https://synchron.foundation",
      assign: (url) => {
        dom.window.document.body.dataset.redirectedTo = url;
      },
    },
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (fetchFails) throw new Error("offline");
      const path = String(url);
      if (path.includes("/api/tester-auth/prepare") && testerPrepareResponse) {
        return testerPrepareResponse;
      }
      if (
        path.includes("/api/digitalocean-domain/prepare") &&
        domainPrepareResponse
      ) {
        domainRequests.push({ path, options });
        return domainPrepareResponse;
      }
      if (
        path.includes("/api/digitalocean-domain/confirm") &&
        domainConfirmResponse
      ) {
        domainRequests.push({ path, options });
        return domainConfirmResponse;
      }
      const result = path.includes("/health/ready")
        ? readiness
        : path.includes("/health/integrations")
          ? integrations
          : path.includes("/api/google/status")
            ? { connected: googleConnected }
            : path.includes("/api/github/status")
              ? { connected: githubConnected }
              : path.includes("/api/tester-auth/status")
                ? testerAuth
                : path.includes("/api/digitalocean-domain/status")
                  ? publicDomain
                  : path.includes("/api/tasks")
                    ? { items: tasks }
                    : path.includes("/api/workspaces")
                      ? workspace || {}
                      : path.includes("/permissions/audit")
                        ? { events: audit }
                        : path.includes("/memory/profile")
                          ? { items: memories }
                          : config || {};
      return {
        ok: true,
        json: async () => result,
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { dom, context, domainRequests };
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

test("action center summarizes projects, pending work, approvals and recent outcomes", async () => {
  const harness = createHarness({
    tasks: [
      { id: "task-1", title: "Продължи теста", status: "in_progress" },
      { id: "task-2", title: "Чака решение", status: "blocked" },
    ],
    workspace: {
      state: {
        activeProjectId: "project-1",
        projects: [
          {
            id: "project-1",
            name: "SYNCHRON-X",
            objective: "Свържи AI CORE",
            run: { nextStep: "Провери реалния разговор" },
          },
        ],
        activities: [{ id: "run-1", status: "needs-input" }],
      },
    },
    audit: [
      {
        action: "mail.send",
        decision: "confirm",
        outcome: "requested",
      },
      {
        action: "memory.write",
        outcome: "succeeded",
        timestamp: "2026-08-06T10:00:00.000Z",
      },
    ],
    memories: [{ id: "memory-1" }, { id: "memory-2" }],
  });
  await openCenter(harness);
  const center = harness.dom.window.document.querySelector(".action-center");

  assert.match(center.textContent, /Център за действие/u);
  assert.match(center.textContent, /Провери реалния разговор/u);
  assert.match(center.textContent, /2 задачи или изпълнения/u);
  assert.match(center.textContent, /1 незавършени задачи/u);
  assert.match(center.textContent, /1 в безопасния журнал/u);
  assert.match(center.textContent, /memory\.write/u);
  assert.match(center.textContent, /1 проекта · 2 управлявани спомена/u);
  assert.equal(center.querySelectorAll(".action-center-card").length, 6);
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
  const journalButton = [
    ...harness.dom.window.document.querySelectorAll(
      '[data-work-center-target="focusBtn"]',
    ),
  ].find((button) => button.textContent.includes("Дневник на задачите"));
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

test("ChatGPT app setup links directly to Plugins and explains the new MCP connection", async () => {
  const harness = createHarness({ fetchFails: true });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="show-chatgpt-app-setup"]',
  );
  card.click();
  const setup = document.querySelector("[data-chatgpt-app-setup]");
  const chatGptLink = [...setup.querySelectorAll("a")].find((link) =>
    link.textContent.includes("ChatGPT Plugins"),
  );

  assert.equal(chatGptLink.href, "https://chatgpt.com/plugins");
  assert.match(setup.textContent, /Security and login/u);
  assert.match(setup.textContent, /Developer mode/u);
  assert.match(setup.textContent, /бутона \+/u);
  assert.match(setup.textContent, /public endpoint/u);
  assert.match(setup.textContent, /MCP server URL/u);
  assert.match(setup.textContent, /Не избирай готовите Google Drive/u);
  assert.match(setup.textContent, /https:\/\/synchron\.foundation\/mcp/u);
  assert.match(setup.textContent, /Завършекът \/mcp е правилен/u);
  assert.equal(setup.querySelector("[data-copy-mcp-url]"), null);
});

test("ChatGPT app card reports the live bridge and shows the exact MCP URL", async () => {
  const harness = createHarness({
    readiness: {
      status: "ready",
      checks: {
        chatAgent: { ready: true },
        memory: { ready: true, status: "green" },
        bridge: {
          configured: true,
          responding: true,
          tools: 11,
          authentication: {
            chatgptOAuthReady: true,
            tokenExchange: { tokenExchange: "success" },
          },
        },
      },
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="show-chatgpt-app-setup"]',
  );

  assert.match(card.textContent, /11 инструмента · OAuth е проверен/u);
  card.click();
  assert.equal(
    document.querySelector("[data-mcp-resource-url]").textContent,
    "https://synchron.foundation/mcp",
  );
  assert.equal(document.querySelector("[data-copy-mcp-url]"), null);
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

test("Tools card reuses the existing live tools drawer action", async () => {
  const harness = createHarness();
  const { document } = harness.dom.window;
  let clicks = 0;
  document.getElementById("toolsBtn").addEventListener("click", () => {
    clicks += 1;
  });
  await openCenter(harness);

  const toolsCard = document.querySelector(
    '[data-work-center-target="toolsBtn"]',
  );
  assert.match(toolsCard.textContent, /Инструменти/u);
  toolsCard.click();
  assert.equal(clicks, 1);
});

test("mobile Connections command opens the Work Center", () => {
  assert.match(
    mobileCommandSource,
    /command === "connections"[\s\S]{0,120}forwardClick\("workCenterBtn", "connections"\)/u,
  );
  assert.doesNotMatch(
    mobileCommandSource,
    /command === "connections"[\s\S]{0,120}forwardClick\("toolsBtn", "connections"\)/u,
  );
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
  assert.match(text, /Активирай потребителски профили/u);
  assert.match(text, /Изисква точно потвърждение/u);
});

test("work center shows normal registration after user auth is active", async () => {
  const harness = createHarness({
    testerAuth: { configured: true, registrationEnabled: true },
  });
  await openCenter(harness);
  const card = harness.dom.window.document.querySelector(
    '[data-work-center-action="copy-registration-link"]',
  );

  assert.match(card.textContent, /Потребителски профили/u);
  assert.match(card.textContent, /Работи · Нормална регистрация/u);
});

test("work center shows the exact public www domain action", async () => {
  const harness = createHarness();
  await openCenter(harness);
  const card = harness.dom.window.document.querySelector(
    '[data-work-center-action="activate-www-domain"]',
  );

  assert.match(card.textContent, /Публичен www адрес/u);
  assert.match(card.textContent, /www\.synchron\.foundation/u);
  assert.match(card.textContent, /Добави www адреса/u);
});

test("public www action uses prepare and exact confirm before reporting deployment", async () => {
  const harness = createHarness({
    domainPrepareResponse: {
      ok: true,
      status: 201,
      json: async () => ({
        confirmationId: "confirmation-www",
        domain: "www.synchron.foundation",
        message: "Ще бъде добавен само www адресът.",
      }),
    },
    domainConfirmResponse: {
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        updated: true,
        domain: "www.synchron.foundation",
        deploymentId: "deploy-www",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  document
    .querySelector('[data-work-center-action="activate-www-domain"]')
    .click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(document.body.textContent, /Потвърди добавянето на www адреса/u);
  assert.match(document.body.textContent, /Адрес: www\.synchron\.foundation/u);
  assert.equal(harness.domainRequests.length, 1);

  document.querySelector("[data-confirm-www-domain]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.domainRequests.length, 2);
  assert.deepEqual(JSON.parse(harness.domainRequests[1].options.body), {
    confirmationId: "confirmation-www",
  });
  assert.match(document.body.textContent, /www адресът се активира/u);
  assert.match(document.body.textContent, /DigitalOcean започва deployment/u);
});

test("public www action can be cancelled without changing DigitalOcean", async () => {
  const harness = createHarness({
    domainPrepareResponse: {
      ok: true,
      status: 201,
      json: async () => ({
        confirmationId: "confirmation-www",
        domain: "www.synchron.foundation",
        message: "Ще бъде добавен само www адресът.",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="activate-www-domain"]',
  );
  card.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  document.querySelector("[data-cancel-www-domain]").click();

  assert.equal(harness.domainRequests.length, 1);
  assert.equal(document.querySelector("[data-www-domain-confirmation]"), null);
  assert.equal(card.disabled, false);
});

test("public www action shows the safe DigitalOcean diagnostic code", async () => {
  const harness = createHarness({
    domainPrepareResponse: {
      ok: false,
      status: 502,
      json: async () => ({
        error: "DigitalOcean не върна валиден app spec.",
        code: "DIGITALOCEAN_INVALID_APP_SPEC",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  document
    .querySelector('[data-work-center-action="activate-www-domain"]')
    .click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(document.body.textContent, /не върна валиден app spec/u);
  assert.match(document.body.textContent, /DIGITALOCEAN_INVALID_APP_SPEC/u);
});

test("copies the normal registration address", async () => {
  const harness = createHarness({
    testerAuth: { configured: true, registrationEnabled: true },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  document
    .querySelector('[data-work-center-action="copy-registration-link"]')
    .click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    document.body.dataset.copiedText,
    "https://synchron.foundation/register",
  );
  assert.match(document.body.textContent, /Адресът за регистрация е копиран/u);
  assert.match(document.body.textContent, /отваря директно регистрацията/u);
});

test("tester auth action is visibly actionable on mobile", async () => {
  const harness = createHarness();
  await openCenter(harness);
  const card = harness.dom.window.document.querySelector(
    '[data-work-center-action="activate-tester-auth"]',
  );

  assert.match(card.textContent, /Натисни за активиране/u);
  assert.ok(card.querySelector(".fa-chevron-right"));
});

test("tester auth error is shown next to the action card", async () => {
  const harness = createHarness({
    testerPrepareResponse: {
      ok: false,
      status: 503,
      json: async () => ({
        error: "DigitalOcean мостът не е достъпен.",
        code: "DIGITALOCEAN_UNAVAILABLE",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="activate-tester-auth"]',
  );

  card.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = card.nextElementSibling;
  assert.equal(result?.dataset.testerAuthResult, "");
  assert.match(result.textContent, /DigitalOcean мостът не е достъпен/u);
});

test("missing owner session opens the protected GitHub login", async () => {
  const harness = createHarness({
    testerPrepareResponse: {
      ok: false,
      status: 401,
      json: async () => ({
        error: "Трябва да влезеш.",
        code: "AUTH_REQUIRED",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="activate-tester-auth"]',
  );

  card.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(document.body.dataset.redirectedTo, "/api/github/connect");
  assert.match(
    card.nextElementSibling.textContent,
    /Необходим е вход на собственика/u,
  );
});

test("DigitalOcean token rejection stays visible and does not open GitHub", async () => {
  const harness = createHarness({
    testerPrepareResponse: {
      ok: false,
      status: 401,
      json: async () => ({
        error: "DigitalOcean токенът е невалиден, изтекъл или е отнет.",
        code: "DIGITALOCEAN_TOKEN_INVALID",
      }),
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="activate-tester-auth"]',
  );

  card.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(document.body.dataset.redirectedTo, undefined);
  assert.match(
    card.nextElementSibling.textContent,
    /DigitalOcean токенът е невалиден/u,
  );
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

test("current capabilities summary uses only live verified status", async () => {
  const harness = createHarness({
    readiness: {
      status: "ready",
      checks: {
        chatAgent: { ready: true },
        memory: { ready: true, status: "green" },
        bridge: {
          configured: true,
          responding: true,
          tools: 11,
          authentication: {
            chatgptOAuthReady: true,
            tokenExchange: { tokenExchange: "success" },
          },
        },
      },
    },
    integrations: {
      tools: [
        "github-read",
        "github-confirmed-write",
        "google-drive-read",
        "gmail-read",
        "google-calendar-read",
      ].map((id) => ({
        id,
        enabled: true,
        executable: true,
        configured: true,
      })),
    },
    googleConnected: true,
    githubConnected: true,
    testerAuth: { configured: true, registrationEnabled: true },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const summary = document.querySelector(".work-center-capabilities");
  const working = summary.querySelector('[data-capability-group="working"]');

  assert.match(summary.textContent, /Какво мога в момента\?/u);
  assert.match(working.textContent, /Работи сега · 8/u);
  assert.match(working.textContent, /AI разговор и постоянна памет/u);
  assert.match(working.textContent, /ChatGPT MCP мост/u);
  assert.match(working.textContent, /GitHub Read/u);
  assert.match(working.textContent, /Google Drive/u);
  assert.match(working.textContent, /Gmail/u);
  assert.match(working.textContent, /Google Calendar/u);
  assert.match(working.textContent, /Потребителски профили/u);
});

test("configured MCP bridge waits for a real OAuth token exchange", async () => {
  const harness = createHarness({
    readiness: {
      status: "ready",
      checks: {
        chatAgent: { ready: true },
        memory: { ready: true, status: "green" },
        bridge: {
          configured: true,
          responding: true,
          tools: 50,
          authentication: {
            chatgptOAuthReady: true,
            tokenExchange: { tokenExchange: "not-attempted" },
          },
        },
      },
    },
  });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const card = document.querySelector(
    '[data-work-center-action="show-chatgpt-app-setup"]',
  );
  const working = document.querySelector('[data-capability-group="working"]');
  const action = document.querySelector('[data-capability-group="action"]');

  assert.match(card.textContent, /50 инструмента · готов за свързване/u);
  assert.doesNotMatch(working.textContent, /ChatGPT MCP мост/u);
  assert.match(action.textContent, /ChatGPT MCP мост/u);
});

test("Cloudflare card does not claim success before a live check", async () => {
  const harness = createHarness({
    integrations: {
      tools: [
        {
          id: "cloudflare-read",
          enabled: true,
          executable: true,
          configured: true,
          healthStatus: "degraded",
          availabilityCode: "CLOUDFLARE_LIVE_CHECK_REQUIRED",
          availabilityReason:
            "Cloudflare е конфигуриран, но тази справка не е жива API проверка.",
        },
      ],
    },
  });
  await openCenter(harness);
  const card = [...harness.dom.window.document.querySelectorAll("a")].find(
    (item) => item.textContent.includes("Cloudflare"),
  );

  assert.match(card.textContent, /конфигуриран · изисква жива проверка/u);
  assert.doesNotMatch(card.textContent, /Cloudflare Read: работи/u);
});

test("current capabilities reports confirmed GitHub Write as unavailable when disconnected", async () => {
  const harness = createHarness({
    integrations: {
      tools: [
        {
          id: "github-read",
          enabled: true,
          executable: true,
          configured: true,
        },
        {
          id: "github-confirmed-write",
          enabled: false,
          executable: false,
          configured: true,
          availabilityCode: "CAPABILITY_AUTH_REQUIRED",
        },
      ],
    },
    githubConnected: true,
  });
  await openCenter(harness);
  const unavailable = harness.dom.window.document.querySelector(
    '[data-capability-group="unavailable"]',
  );

  assert.match(unavailable.textContent, /GitHub запис с точно потвърждение/u);
  assert.doesNotMatch(
    harness.dom.window.document.querySelector(
      '[data-capability-group="working"]',
    ).textContent,
    /GitHub запис/u,
  );
});

test("missing Google session is an action and never a working capability", async () => {
  const harness = createHarness({ googleConnected: false });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const working = document.querySelector('[data-capability-group="working"]');
  const action = document.querySelector('[data-capability-group="action"]');

  assert.doesNotMatch(
    working.textContent,
    /Google Drive|Gmail|Google Calendar/u,
  );
  assert.match(action.textContent, /Google Drive/u);
  assert.match(action.textContent, /Gmail/u);
  assert.match(action.textContent, /Google Calendar/u);
});

test("unavailable runtime status is never presented as working", async () => {
  const harness = createHarness({ fetchFails: true });
  await openCenter(harness);
  const { document } = harness.dom.window;
  const summary = document.querySelector(".work-center-capabilities");
  const working = summary.querySelector('[data-capability-group="working"]');
  const unavailable = summary.querySelector(
    '[data-capability-group="unavailable"]',
  );

  assert.match(working.textContent, /Работи сега · 0/u);
  assert.match(unavailable.textContent, /AI разговор и постоянна памет/u);
  assert.match(unavailable.textContent, /ChatGPT MCP мост/u);
  assert.match(unavailable.textContent, /Google Drive/u);
  assert.doesNotMatch(summary.textContent, /secret|token|password/iu);
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
  assert.match(
    css,
    /@media\s*\(\s*max-width:\s*520px\s*\).*?\.work-center-capabilities-grid\s*\{[^}]*grid-template-columns:\s*1fr/su,
  );
  assert.match(
    accessibilityCss,
    /data-font-scale="max"[^}]*\.work-center-capabilities-title\s*\{[^}]*font-size:\s*var\(--synchron-card-title\)/su,
  );
});
