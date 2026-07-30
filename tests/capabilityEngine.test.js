import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegrationStatusReport,
  CapabilityError,
  executeCapability,
  getToolRuntimeAvailability,
  isToolExecutable,
  resolveCapability,
} from "../src/tools/capabilityEngine.js";
import {
  getTool,
  registerCoreTools,
  registerTool,
  resetToolRegistryForTests,
} from "../src/tools/toolRegistry.js";

test.beforeEach(() => resetToolRegistryForTests());

test("избира GitHub без AI Core да знае конкретния инструмент", () => {
  const result = resolveCapability("code.read");
  assert.equal(result.tool.id, "github-read");
  assert.equal(result.permission.decision, "allow");
  assert.equal(result.requiresConfirmation, false);
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

test("маркира GitHub Copilot адаптера като изпълним и изисква потвърждение", () => {
  const result = resolveCapability("code.write");
  assert.equal(result.tool.id, "github-write");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(isToolExecutable("github-write"), true);
});

test("регистрира Supabase като изпълним инструмент само за статус", () => {
  const result = resolveCapability("database.status");
  assert.equal(result.tool.id, "supabase-status");
  assert.equal(result.permission.decision, "allow");
  assert.equal(result.requiresConfirmation, false);
  assert.equal(isToolExecutable("supabase-status"), true);
});

test("runtime availability blocks configured-looking tools without credentials", () => {
  assert.equal(
    getToolRuntimeAvailability("supabase-status", {}, {}).available,
    false,
  );
  assert.equal(
    getToolRuntimeAvailability(
      "supabase-status",
      {},
      {
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
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
      error.code === "CAPABILITY_NOT_CONFIGURED",
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
      checkSupabase: async () => ({ status: "healthy" }),
      checkDigitalOcean: async () => ({ app: { id: "app-1" } }),
      env: { OPENAI_API_KEY: "configured" },
    },
  );

  assert.match(report, /Проверих инструментите реално сега/u);
  assert.match(report, /GitHub Read/u);
  assert.match(report, /Synchron Memory/u);
  assert.match(report, /Supabase Status/u);
  assert.match(report, /DigitalOcean Read/u);
  assert.match(report, /Google Drive — изисква Google вход/u);
  assert.match(report, /GitHub Write — свързан; изисква потвърждение/u);
});

test("връща фокусиран проверен статус за GitHub Copilot моста", async () => {
  const report = await buildIntegrationStatusReport(
    {
      message: "Работи ли GitHub Write мостът?",
      githubSessionId: "github-session",
    },
    {
      checkGitHubWriteBridge: async () => ({
        status: "ready",
        configured: true,
        connected: true,
        copilotEnabled: true,
        repository: "radostinvgeorgiev-commits/sunchron-backend",
        createsBranch: true,
        createsCommits: true,
        createsPullRequest: true,
        mergesMainAutomatically: false,
      }),
    },
  );

  assert.match(report, /GitHub Write моста реално: работи/u);
  assert.match(report, /отделен клон/u);
  assert.match(report, /Pull Request/u);
  assert.match(report, /Не слива автоматично/u);
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
  for (const id of [
    "github-read",
    "synchron-integrations-status",
    "github-write",
    "google-drive-read",
    "google-calendar-read",
    "gmail-read",
    "openai-web-search",
    "supabase-status",
    "opensearch-memory",
  ]) {
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
