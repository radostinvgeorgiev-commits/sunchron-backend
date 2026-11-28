import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";

import { getIntegrationStatus } from "../src/routes/health.js";
import { createLocalDocumentStore } from "../src/services/localDocumentStore.js";
import { createToolSwitchService } from "../src/services/toolSwitchService.js";
import { resetToolRegistryForTests } from "../src/tools/toolRegistry.js";

// „Инструменти“ as a person sees it: the real page, its languages and app.js,
// with the site's answers stubbed. Found in the review of 28.11: „Моите
// задачи“ said „Не е конфигуриран“ to everyone, several words stayed in
// Bulgarian on the other languages, and a press could open the closed list.
const read = (path) => readFile(new URL(`../public/${path}`, import.meta.url), "utf8");
const [html, english, locale, app] = await Promise.all(
  ["index.html", "locale-en.js", "locale.js", "app.js"].map(read),
);
const catalogs = Object.fromEntries(
  await Promise.all(
    ["de", "es", "fr", "it", "ro"].map(async (code) => [code, JSON.parse(await read(`locales/${code}.json`))]),
  ),
);

const MEMBER = Object.freeze({ role: "member", memoryOwnerId: "member-b" });
const OWNER = Object.freeze({ role: "owner", memoryOwnerId: "owner-a" });
const SITE = {
  OPENAI_API_KEY: "set",
  GEMINI_API_KEY: "set",
  GOOGLE_CLIENT_ID: "set",
  GOOGLE_CLIENT_SECRET: "set",
  GOOGLE_REDIRECT_URI: "https://novariumai.com/api/google/callback",
  GITHUB_CLIENT_ID: "set",
  GITHUB_CLIENT_SECRET: "set",
  MEMORY_BACKEND: "firestore",
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_CLOUD_PROJECT: "novarium-test-project",
};

// What /health/integrations answers on a site with its stores set up.
function siteTools() {
  const original = Object.fromEntries(Object.keys(SITE).map((key) => [key, process.env[key]]));
  Object.assign(process.env, SITE);
  resetToolRegistryForTests();
  try {
    return getIntegrationStatus({ githubAuthenticated: false });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetToolRegistryForTests();
  }
}

async function page(t, { lang = "bg", role = "member", routes = {} } = {}) {
  const dom = new JSDOM(html, {
    url: `https://novariumai.com/?lang=${lang}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const asked = [];
  const sent = [];
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "https://novariumai.com");
    const method = String(init.method || "GET").toUpperCase();
    if (url.pathname.startsWith("/locales/")) {
      const catalog = catalogs[url.pathname.slice("/locales/".length, -".json".length)];
      return catalog ? Response.json(catalog) : Response.json({}, { status: 404 });
    }
    sent.push(`${method} ${url.pathname}`);
    const handler = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (handler === undefined) return Response.json({}, { status: 404 });
    const answer = typeof handler === "function" ? await handler({ init }) : handler;
    // { status, body } is an answer with its own status; anything else is a body.
    const own = typeof answer?.status === "number" && Object.hasOwn(answer, "body");
    return Response.json(own ? answer.body : answer, { status: own ? answer.status : 200 });
  };
  window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.confirm = (question) => {
    asked.push(question);
    return false;
  };
  const context = dom.getInternalVMContext();
  const run = (code, filename) => new vm.Script(code, { filename }).runInContext(context);
  run(english, "locale-en.js");
  run(locale, "locale.js");
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await window.NovariumLocale.ready;
  run(app, "app.js");
  window.document.body.dataset.userRole = role;
  run(
    `elements.dataDrawerBody.addEventListener("click", handleDataDrawerAction);
     elements.closeDataDrawerBtn.addEventListener("click", closeDataDrawer);`,
    "listeners.js",
  );
  const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  const openTools = async () => {
    await run("openToolsDrawer()", "open.js");
    await settle();
  };
  const body = window.document.getElementById("dataDrawerBody");
  // Every piece of text the person reads that is still in Bulgarian.
  const bulgarian = () => {
    const walker = window.document.createTreeWalker(body, window.NodeFilter.SHOW_TEXT);
    const found = new Set();
    while (walker.nextNode()) {
      const text = walker.currentNode.data.replace(/\s+/gu, " ").trim();
      if (/[Ѐ-ӿ]/u.test(text)) found.add(text);
    }
    return [...found];
  };
  const card = (id) => window.document.querySelector(`[data-tool-card="${id}"]`);
  return { window, document: window.document, body, asked, sent, settle, openTools, bulgarian, card };
}

const switchRoutes = (identity, ownerId, extra = {}) => {
  const switches = createToolSwitchService({ store: createLocalDocumentStore() });
  return {
    "/health/integrations": siteTools(),
    "GET /api/tools/switches": () => switches.list(ownerId, identity),
    ...extra,
  };
};

test("a person's own „Моите задачи“ shows as connected, not as not set up", async (t) => {
  const view = await page(t, { routes: switchRoutes(MEMBER, "member-b", { "/api/google/status": { connected: false } }) });
  await view.openTools();
  const todos = view.card("personal-todos");
  assert.ok(todos, "the card is there");
  assert.equal(todos.querySelector(".tool-link-state")?.textContent, "Свързан");
  assert.doesNotMatch(todos.textContent, /Не е конфигуриран/u);
  assert.ok(todos.querySelector('[data-tool-switch="personal-todos"][data-tool-on="false"]'), "it has „Разкачи“");
});

for (const lang of ["de", "es", "fr", "it", "ro"]) {
  test(`„Инструменти“ for a person is all in the chosen language (${lang})`, async (t) => {
    for (const connected of [false, true]) {
      const view = await page(t, {
        lang,
        routes: switchRoutes(MEMBER, "member-b", {
          "/api/google/status": { connected },
          // Gmail not allowed yet: its card offers „Разреши“.
          "/api/google/check": {
            services: {
              gmail: { ok: false, connect: "/api/google/connect?add=gmail" },
              drive: { ok: true },
              calendar: { ok: true },
              contacts: { ok: true },
              youtube: { ok: true },
            },
          },
        }),
      });
      await view.openTools();
      assert.deepEqual(view.bulgarian(), [], `${lang}, Google ${connected ? "connected" : "not connected"}`);
      assert.equal(view.card("personal-todos")?.querySelector("strong")?.textContent, catalogs[lang]["My tasks"]);
      if (connected) {
        assert.equal(view.card("gmail-read")?.querySelector("a.tool-connect-btn")?.textContent, catalogs[lang].Allow);
      }
    }
  });
}

test("the owner's „Инструменти“ is all English on the English page, ChatGPT's count too", async (t) => {
  const view = await page(t, {
    lang: "en",
    role: "owner",
    routes: switchRoutes(OWNER, "owner-a", {
      "/api/google/status": { connected: false },
      "/api/github/status": { connected: false },
      "/permissions/oauth/chatgpt": { configured: true, connected: true, grants: [{ scopes: ["read", "write"] }] },
    }),
  });
  await view.openTools();
  assert.deepEqual(view.bulgarian(), []);
  const chatgpt = [...view.document.querySelectorAll(".connection-control-card")].find((node) =>
    node.querySelector("strong")?.textContent === "ChatGPT",
  );
  assert.match(chatgpt.textContent, /Active MCP connections: 1 · permissions: 2/u);
  assert.equal(view.card("openai-codex")?.querySelector("strong")?.textContent, "Code with Claude");
  assert.equal(view.card("github-read")?.querySelector(".tool-connect-btn")?.textContent, "Connect GitHub");

  // „Разкачи“ on ChatGPT asks first, in English; a „no“ sends nothing.
  chatgpt.querySelector('[data-disconnect-service="chatgpt"]').click();
  await view.settle();
  assert.deepEqual(view.asked, ["Remove all of ChatGPT's active permissions to NovariumAI?"]);
  assert.equal(view.sent.includes("POST /permissions/oauth/chatgpt/revoke"), false);
});

test("a failed press shows the switch's own words, and plain ones for any other answer", async (t) => {
  for (const [answer, shown] of [
    [{ status: 404, body: { error: "Няма такъв инструмент.", code: "TOOL_SWITCH_NOT_FOUND" } }, "There is no such tool."],
    [{ status: 401, body: { error: "Session token missing or invalid", code: "AUTH_REQUIRED" } }, "The change was not saved. Try again."],
    [{ status: 429, body: { error: "Too many requests" } }, "The change was not saved. Try again."],
  ]) {
    const view = await page(t, {
      lang: "en",
      routes: switchRoutes(MEMBER, "member-b", {
        "/api/google/status": { connected: false },
        "PUT /api/tools/switches/openai-web-search": answer,
      }),
    });
    await view.openTools();
    view.card("openai-web-search").querySelector('[data-tool-switch][data-tool-on="false"]').click();
    await view.settle();
    const note = view.card("openai-web-search").querySelector('[role="alert"]');
    assert.equal(note?.textContent, shown);
    assert.equal(view.card("openai-web-search").querySelector("[data-tool-switch]").disabled, false, "the press can be tried again");
  }
});

test("„Разкачи“ shows the new state, and a list closed meanwhile stays closed", async (t) => {
  for (const close of [false, true]) {
    let release;
    const view = await page(t, {
      routes: switchRoutes(MEMBER, "member-b", {
        "/api/google/status": { connected: false },
        "PUT /api/tools/switches/openai-web-search": () =>
          new Promise((resolve) => {
            release = () => resolve({ tools: [] });
          }),
      }),
    });
    await view.openTools();
    view.card("openai-web-search").querySelector('[data-tool-switch][data-tool-on="false"]').click();
    await view.settle(5);
    if (close) view.document.getElementById("closeDataDrawerBtn").click();
    release();
    await view.settle();
    const drawer = view.document.getElementById("dataDrawer");
    const readings = view.sent.filter((line) => line === "GET /api/tools/switches").length;
    if (close) {
      assert.equal(drawer.hidden, true, "it does not open again by itself");
      assert.equal(readings, 1);
    } else {
      assert.equal(drawer.hidden, false);
      assert.equal(readings, 2, "the list is read again and shows the new state");
    }
  }
});
