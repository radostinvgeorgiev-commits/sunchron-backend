import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegrationStatusReport,
  CapabilityError,
  contactSavedReply,
  executeCapability,
  getToolRuntimeAvailability,
  isToolExecutable,
  resolveCapability,
} from "../src/tools/capabilityEngine.js";
import {
  getTool,
  listTools,
  registerCoreTools,
  registerTool,
  resetToolRegistryForTests,
} from "../src/tools/toolRegistry.js";
import { isActiveAuthorizedGitHubSession } from "../src/services/githubOAuthService.js";
import { createSession } from "../src/services/googleDriveService.js";

test.beforeEach(() => resetToolRegistryForTests());

test("избира GitHub без NovariumAI да знае конкретния инструмент", () => {
  const result = resolveCapability("code.read");
  assert.equal(result.tool.id, "github-read");
  assert.equal(result.permission.decision, "allow");
  assert.equal(result.requiresConfirmation, false);
});

test("избира Codex само за изолиран кодов анализ", () => {
  const result = resolveCapability("code.analyze");
  assert.equal(result.tool.id, "openai-codex");
  assert.equal(result.permission.action, "code.execute.read");
  assert.equal(result.permission.decision, "allow");
  assert.equal(result.requiresConfirmation, false);
  assert.equal(isToolExecutable("openai-codex"), true);
});

test("маркира опасните действия за потвърждение", () => {
  const result = resolveCapability("memory.delete");
  assert.equal(result.permission.action, "memory.delete");
  assert.equal(result.permission.decision, "confirm");
  assert.equal(result.requiresConfirmation, true);
});

test("избира точното разрешение за всяка способност на паметта", () => {
  assert.equal(
    resolveCapability("memory.search").permission.action,
    "memory.read",
  );
  assert.equal(
    resolveCapability("memory.save").permission.action,
    "memory.write",
  );
  assert.equal(
    resolveCapability("memory.update").permission.action,
    "memory.write",
  );
});

test("регистрира основните инструменти и при наличен външен инструмент", () => {
  registerTool({
    id: "custom-search",
    provider: "custom",
    name: "Custom Search",
    version: "1.0.0",
    category: "search",
    capabilities: ["custom.search"],
    permissions: ["web.read"],
    capabilityPermissions: { "custom.search": "web.read" },
    enabled: true,
    requiresConfirmation: false,
    healthStatus: "healthy",
  });

  registerCoreTools();
  assert.ok(getTool("custom-search"));
  assert.ok(getTool("github-read"));
  assert.ok(getTool("google-calendar-read"));
});

test("блокира липсваща способност по подразбиране", () => {
  assert.throws(
    () => resolveCapability("bank.transfer"),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("регистрира директния NovariumAI Code Write адаптер", () => {
  const result = resolveCapability("code.write");
  assert.equal(result.tool.id, "github-write");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(isToolExecutable("github-write"), true);
});

test("Calendar Write има изпълним адаптер и изисква потвърждение", () => {
  const result = resolveCapability("calendar.write");
  assert.equal(result.tool.id, "google-calendar-write");
  assert.equal(result.permission.action, "calendar.write");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(isToolExecutable("google-calendar-write"), true);
});

test("granular mail, contacts, tasks and GitHub writes use exact permission decisions", () => {
  for (const [capability, action, decision] of [
    ["mail.draft", "mail.draft", "allow"],
    ["mail.send", "mail.send", "confirm"],
    ["mail.delete", "mail.delete", "confirm"],
    ["contacts.read", "contacts.read", "allow"],
    ["contacts.create", "contacts.write", "confirm"],
    ["tasks.draft", "tasks.draft", "allow"],
    ["tasks.status", "tasks.update", "confirm"],
    ["github.branch.create", "github.write", "confirm"],
    ["github.pull-request.merge", "github.write", "confirm"],
  ]) {
    const resolved = resolveCapability(capability);
    assert.equal(resolved.permission.action, action, capability);
    assert.equal(resolved.permission.decision, decision, capability);
    assert.equal(
      resolved.requiresConfirmation,
      decision === "confirm",
      capability,
    );
  }
});

test("не регистрира legacy database status инструмент", () => {
  assert.equal(getTool("supabase-status"), null);
  assert.equal(isToolExecutable("supabase-status"), false);
  assert.throws(
    () => resolveCapability("database.status"),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("runtime availability blocks configured-looking tools without credentials", () => {
  assert.equal(
    getToolRuntimeAvailability("openai-codex", {}, {}).available,
    false,
  );
  assert.equal(
    getToolRuntimeAvailability(
      "openai-codex",
      {},
      { ANTHROPIC_API_KEY: "key", CODEX_AGENT_ENABLED: "false" },
    ).code,
    "CODEX_AGENT_NOT_CONFIGURED",
  );
  // The code agent runs on Claude: an OpenAI key alone is not enough.
  assert.equal(
    getToolRuntimeAvailability("openai-codex", {}, { OPENAI_API_KEY: "key" })
      .available,
    false,
  );
  assert.equal(
    getToolRuntimeAvailability("openai-codex", {}, { ANTHROPIC_API_KEY: "key" })
      .available,
    true,
  );
  assert.equal(
    getToolRuntimeAvailability(
      "github-confirmed-write",
      { githubSessionId: "owner-session" },
      {
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
      },
    ).available,
    true,
  );
  assert.equal(
    getToolRuntimeAvailability(
      "github-write",
      { githubSessionId: "owner-session" },
      {
        OPENAI_API_KEY: "openai",
        GEMINI_API_KEY: "gemini",
        GROK_API_KEY: "grok",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
      },
    ).available,
    true,
  );
  assert.equal(
    getToolRuntimeAvailability(
      "google-calendar-read",
      {},
      {
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.test/callback",
      },
    ).code,
    "CAPABILITY_AUTH_REQUIRED",
  );
});

test("Google Cloud Write accepts the verified Cloud Run runtime markers", () => {
  const result = getToolRuntimeAvailability(
    "google-cloud-write",
    {},
    {
      K_SERVICE: "synchron-backend-google",
      K_REVISION: "synchron-backend-google-00058-gbn",
    },
  );
  assert.equal(result.available, true);
});

test("NovariumAI chat availability accepts a configured non-OpenAI provider", () => {
  const result = getToolRuntimeAvailability(
    "synchron-agent-chat",
    { ownerId: "supabase:test" },
    {
      GEMINI_API_KEY: "key",
      GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
    },
  );
  assert.equal(result.available, true);
});

test("NovariumAI chat and memory availability accept Firestore without OpenSearch", () => {
  const env = {
    OPENAI_API_KEY: "key",
    MEMORY_BACKEND: "firestore",
    GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
    FIRESTORE_DATABASE_ID: "(default)",
  };
  assert.equal(
    getToolRuntimeAvailability(
      "synchron-agent-chat",
      { ownerId: "identity-platform:user-a" },
      env,
    ).available,
    true,
  );
  assert.equal(
    getToolRuntimeAvailability("google-firestore-memory", {}, env).available,
    true,
  );
});

test("code.write спира преди multi-engine flow без конфигуриран двигател", async () => {
  await assert.rejects(
    () =>
      executeCapability(
        "code.write",
        {
          githubSessionId: "owner-session",
          message: "Създай Pull Request.",
        },
        {
          env: {
            GITHUB_CLIENT_ID: "client",
            GITHUB_CLIENT_SECRET: "secret",
          },
          prepareConfirmation: true,
        },
      ),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_NOT_CONFIGURED" &&
      /не е конфигуриран/u.test(error.message),
  );
});

test("execution fails closed before calling an unconfigured external tool", async () => {
  await assert.rejects(
    () =>
      executeCapability(
        "database.status",
        {},
        {
          env: {},
        },
      ),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("изпълнява GitHub четене чрез избрания инструмент", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  global.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          sha: "fa21ebb1234567890",
          commit: {
            message: "Capability Core",
            author: { name: "Codex", date: "2026-07-26T00:00:00Z" },
          },
          html_url: "https://github.test/commit/fa21ebb",
        },
      ]),
      { status: 200 },
    );

  try {
    const result = await executeCapability("code.read", {
      message: "Покажи последните commit-и в GitHub.",
    });
    assert.equal(result.tool.id, "github-read");
    assert.match(result.output, /fa21ebb/u);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
  }
});

test("подава активната GitHub owner сесия и не пада към static token при невалиден id", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.GITHUB_API_URL;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  process.env.GITHUB_TOKEN = "configured-read-token";
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, "Bearer oauth-read-token");
    return new Response(
      JSON.stringify([
        {
          sha: "oauth1234567890",
          commit: { message: "OAuth read", author: {} },
          html_url: "https://github.test/commit/oauth123",
        },
      ]),
      { status: 200 },
    );
  };

  try {
    const result = await executeCapability("code.read", {
      ownerId: "primary-user",
      message: "Покажи последните commit-и в GitHub.",
      githubSession: {
        accessToken: "oauth-read-token",
        login: "radostinvgeorgiev-commits",
      },
    });
    assert.match(result.output, /oauth12/u);
    assert.equal(
      isActiveAuthorizedGitHubSession({
        accessToken: "oauth-read-token",
        login: "radostinvgeorgiev-commits",
      }),
      true,
    );

    await assert.rejects(
      () =>
        executeCapability("code.read", {
          ownerId: "primary-user",
          message: "Покажи последните commit-и в GitHub.",
          githubSessionId: "missing-session",
        }),
      (error) =>
        error instanceof CapabilityError &&
        error.code === "GITHUB_SESSION_INVALID" &&
        error.status === 401,
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});

test("връща общ статус само след реални проверки", async () => {
  const report = await buildIntegrationStatusReport(
    {
      ownerId: "primary-user",
      githubSessionId: "github-session",
      googleSessionId: "",
    },
    {
      checkGitHub: async () => true,
      checkMemory: async () => [],
      checkGoogleCloud: async () => ({ configured: true }),
      probeProviders: async () => [
        { id: "openai", label: "OpenAI", configured: true, working: true, model: "gpt-x" },
        { id: "gemini", label: "Gemini", configured: true, working: false, reason: "моделът не съществува" },
        { id: "grok", label: "Grok", configured: true, working: true, model: "grok-x" },
        { id: "claude", label: "Claude", configured: false, working: false, reason: "няма ключ" },
      ],
      env: {
        AI_CORE_PROVIDER: "grok",
        OPENAI_API_KEY: "configured",
        GEMINI_API_KEY: "configured",
        GROK_API_KEY: "configured",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
      },
    },
  );

  assert.match(report, /Проверих инструментите реално сега/u);
  assert.match(report, /GitHub Read/u);
  assert.match(report, /Google Cloud Memory/u);
  assert.doesNotMatch(report, /Supabase|OpenSearch/u);
  assert.match(report, /Google Cloud Read/u);
  assert.match(report, /Google Drive — изисква Google вход/u);
  assert.match(report, /GitHub Write — свързан; изисква потвърждение/u);
  assert.match(report, /✅ OpenAI — работи \(gpt-x\)/u);
  assert.match(report, /❌ Gemini — моделът не съществува/u);
  assert.match(report, /✅ Grok — работи \(grok-x\); основен за разговора/u);
  assert.match(report, /— Claude — няма ключ/u);
  assert.doesNotMatch(report, /конфигуриран;/u);
});

test("a stale GitHub sign-in fails the status check without stopping the server", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error("no network in this test");
  };
  try {
    const report = await buildIntegrationStatusReport(
      {
        ownerId: "primary-user",
        githubSession: { accessToken: "stale-token", expiresAt: 1 },
      },
      {
        checkMemory: async () => [],
        checkGoogleCloud: async () => ({ configured: true }),
        probeProviders: async () => [],
        env: {},
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.match(report, /GitHub Read — реалната проверка е неуспешна/u);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("не обявява Google Cloud за работещ без runtime конфигурация", async () => {
  const report = await buildIntegrationStatusReport(
    { ownerId: "primary-user" },
    {
      checkGitHub: async () => true,
      checkMemory: async () => [],
      checkGoogleCloud: async () => ({ configured: false }),
      env: {},
    },
  );

  assert.match(report, /Google Cloud Read — реалната проверка е неуспешна/u);
});

test("връща фокусиран статус за директния NovariumAI Code Write", async () => {
  const report = await buildIntegrationStatusReport(
    {
      message: "Работи ли GitHub Write мостът?",
      githubSessionId: "github-session",
    },
    {},
  );

  assert.match(
    report,
    /реалният запис се изпълнява чрез свързания GitHub Write API/u,
  );
  assert.match(report, /отделен branch/u);
  assert.match(report, /Pull Request/u);
  assert.match(report, /main не се променя директно/u);
});

test("не изпълнява способност за потвърждение без разрешение", async () => {
  await assert.rejects(
    () => executeCapability("memory.delete"),
    (error) =>
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_CONFIRMATION_REQUIRED",
  );
});

test("всеки регистриран основен инструмент има изпълним адаптер", () => {
  registerCoreTools();
  for (const { id } of listTools()) {
    assert.equal(isToolExecutable(id), true, id);
  }
});

test("изпълнява интернет търсене през OpenAI инструмента", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Във Варна е слънчево.",
                annotations: [],
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );

  try {
    const result = await executeCapability("web.search", {
      message: "Провери актуалното време във Варна.",
    });
    assert.equal(result.tool.id, "openai-web-search");
    assert.match(result.output, /Във Варна е слънчево/u);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("a new Google contact from the chat is only prepared, with a summary in the reply language", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const prepare = (language) =>
    executeCapability(
      "contacts.create",
      {
        ownerId: "member-1",
        googleSessionId: "google-1",
        sessionId: "chat-1",
        ...(language ? { language } : {}),
        input: { contact: { name: "Ana Lee", email: "ana@example.com", phone: "+1 555 0100" } },
      },
      { env, prepareConfirmation: true },
    );
  const english = await prepare("en");
  assert.equal(english.requiresConfirmation, true);
  assert.ok(english.metadata.confirmationId);
  assert.equal(
    english.metadata.summary,
    'Add the Google contact "Ana Lee" (ana@example.com, +1 555 0100).',
  );
  const bulgarian = await prepare();
  assert.equal(
    bulgarian.metadata.summary,
    "Добавяне на Google контакт „Ana Lee“ (ana@example.com, +1 555 0100).",
  );
});

test("the reply after a contact is saved names what Google kept, never the request", () => {
  assert.equal(
    contactSavedReply({ name: "Reviewer Demo", email: "reviewer.demo@example.com" }, true),
    "Google contact saved: Reviewer Demo.",
  );
  // Google did not keep the requested name: the reply says so and shows the email.
  assert.equal(
    contactSavedReply({ name: "", nameSaved: false, email: "reviewer.demo@example.com" }, true),
    "Google contact saved, but Google did not keep its name: reviewer.demo@example.com.",
  );
  assert.equal(
    contactSavedReply({ name: "", nameSaved: false, phone: "+1 555 0100" }),
    "Google контактът е записан, но Google не запази името: +1 555 0100.",
  );
  assert.equal(
    contactSavedReply({ name: "Мама", unchanged: true }),
    "Google контактът вече има тези данни: Мама.",
  );
  assert.equal(contactSavedReply({}, true), "Google contact saved: (no name).");
});

test("a found contact with no name, email or phone still gets a readable line", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const googleSessionId = await createSession({ access_token: "token", expires_in: 3600 });
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        results: [
          { person: { resourceName: "people/p1", names: [{ displayName: "Ana Lee" }] } },
          { person: { resourceName: "people/p2" } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    const search = (language) =>
      executeCapability(
        "contacts.read",
        { ownerId: "member-1", googleSessionId, query: "Acme", ...(language ? { language } : {}) },
        { env },
      );
    assert.equal((await search("en")).output, "Contacts found:\n• Ana Lee\n• (no name)");
    assert.equal((await search()).output, "Намерени контакти:\n• Ana Lee\n• (без име)");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a contact change without a name, or with only a name, gets a clean summary", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const prepare = (contact, language) =>
    executeCapability(
      "contacts.update",
      {
        ownerId: "member-1",
        googleSessionId: "google-1",
        sessionId: "chat-1",
        ...(language ? { language } : {}),
        input: { contact: { resourceName: "people/c1", etag: "etag-1", ...contact } },
      },
      { env, prepareConfirmation: true },
    );
  const phoneOnly = { name: "", phone: "+359 88 000 0001" };
  assert.equal(
    (await prepare(phoneOnly, "en")).metadata.summary,
    "Update the Google contact (+359 88 000 0001).",
  );
  assert.equal(
    (await prepare(phoneOnly)).metadata.summary,
    "Промяна на Google контакт (+359 88 000 0001).",
  );
  assert.equal((await prepare({ name: "Нов" }, "en")).metadata.summary, 'Update the Google contact "Нов".');
  assert.equal((await prepare({ name: "Нов" })).metadata.summary, "Промяна на Google контакт „Нов“.");
});

// RADKO 28.11: „искам да пратя мейл до мен“. „до мен“ is the address of the
// person's own connected Google account (its sign-in id_token); without one
// the person is asked for an address and nothing is prepared.
test("an email „до мен“ is prepared for the address of the person's own Google account", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const token = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const prepare = (googleSessionId, language) =>
    executeCapability(
      "mail.send",
      {
        ownerId: "member-1",
        googleSessionId,
        sessionId: "chat-1",
        ...(language ? { language } : {}),
        input: { to: "", toSelf: true, subject: "Проба", body: "Здравей!" },
      },
      { env, prepareConfirmation: true },
    );
  const own = await createSession({
    access_token: "token",
    expires_in: 3600,
    id_token: token({ sub: "1", email: "ana@example.com", email_verified: true }),
  });
  const result = await prepare(own);
  assert.equal(result.metadata.summary, "Изпращане на имейл до ana@example.com (тема: Проба).");
  assert.equal((await prepare(own, "en")).metadata.summary, "Send an email to ana@example.com (subject: Проба).");
  for (const tokens of [{}, { id_token: token({ sub: "2", email: "ana@example.com", email_verified: false }) }]) {
    const bare = await createSession({ access_token: "token", expires_in: 3600, ...tokens });
    await assert.rejects(prepare(bare), /Напиши адреса вместо „мен“/u);
    await assert.rejects(prepare(bare, "en"), /Write the address instead of “me”/u);
  }
});

// Item 3 („какво ми е деня днес“): the day's events with their hour, and the
// day's mail said as today's.
test("one day of the calendar and today's mail are read as that day's", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const googleSessionId = await createSession({ access_token: "token", expires_in: 3600 });
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
  const urls = [];
  let events = [
    { id: "e1", summary: "Среща с Иван", start: { dateTime: `${today}T10:00:00+02:00` }, end: { dateTime: `${today}T11:00:00+02:00` } },
    { id: "e2", summary: "Рожден ден", start: { date: today }, end: { date: today } },
  ];
  let mail = [{ id: "m1" }];
  // 06:12 UTC on the Sofia day: 08:12 in winter, 09:12 in summer.
  const sentAt = new Date(`${today}T06:12:00Z`);
  const clock = new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(sentAt);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(url).startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) return json({ items: events });
    if (String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return json({ messages: mail });
    if (String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?")) {
      return json({
        id: "m1",
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "Subject", value: "Фактура" },
            { name: "From", value: "Банка <bank@example.com>" },
            { name: "Date", value: sentAt.toUTCString() },
          ],
        },
      });
    }
    return json({});
  };
  try {
    const day = (language) =>
      executeCapability("calendar.read", { ownerId: "owner", googleSessionId, input: { date: today }, ...(language ? { language } : {}) }, { env });
    assert.equal((await day()).output, `Google Calendar за днес, ${today.slice(8, 10)}.${today.slice(5, 7)}.${today.slice(0, 4)}:\n• 10:00 — Среща с Иван\n• цял ден — Рожден ден`);
    const window = new URL(urls[0]).searchParams;
    assert.match(window.get("timeMin"), new RegExp(`^${today}T00:00:00\\+0[23]:00$`, "u"));
    assert.equal(window.get("timeZone"), "Europe/Sofia");
    events = [];
    assert.match((await day("en")).output, /^No events in Google Calendar for today, /u);

    const todayMail = () =>
      executeCapability("mail.read", { ownerId: "owner", googleSessionId, input: { query: "newer_than:1d", day: true } }, { env });
    assert.equal((await todayMail()).output, `Писма днес:\n• Непрочетено — Фактура — Банка <bank@example.com> (${clock})`);
    // The latest letters say the day too (Team 2's probe 28.11: without dates
    // the agent could not tell which letters are today's).
    const latest = await executeCapability("mail.read", { ownerId: "owner", googleSessionId }, { env });
    assert.equal(
      latest.output,
      `Последни съобщения в Gmail:\n• Непрочетено — Фактура — Банка <bank@example.com> (${today.slice(8, 10)}.${today.slice(5, 7)} ${clock})`,
    );
    mail = [];
    assert.equal((await todayMail()).output, "Днес няма нови писма.");
  } finally {
    global.fetch = originalFetch;
  }
});

// A letter from an earlier year says its year, so it never reads as today's
// (review of #605).
test("an older letter shows its year, this year's letters do not", async () => {
  const env = {
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://example.test/api/google/callback",
  };
  const googleSessionId = await createSession({ access_token: "token", expires_in: 3600 });
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
  const lastYear = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const sentAt = new Date(`${lastYear}T10:12:00Z`);
  const clock = new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(sentAt);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return json({ messages: [{ id: "old1" }] });
    if (String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/old1?")) {
      return json({
        id: "old1",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Фактура" },
            { name: "From", value: "Банка <bank@example.com>" },
            { name: "Date", value: sentAt.toUTCString() },
          ],
        },
      });
    }
    return json({});
  };
  try {
    const found = await executeCapability("mail.read", { ownerId: "owner", googleSessionId, query: "from:bank" }, { env });
    assert.equal(
      found.output,
      `Последни съобщения в Gmail:\n• Фактура — Банка <bank@example.com> (${lastYear.slice(8, 10)}.${lastYear.slice(5, 7)}.${lastYear.slice(0, 4)} ${clock})`,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
