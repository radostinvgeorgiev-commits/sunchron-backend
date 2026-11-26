import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_CORE_PROVIDER = "openai";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";

const { default: app } = await import("../server.js");
const { setFirestoreMemoryStoreForTests } = await import(
  "../src/services/memoryService.js"
);

// A memory store whose every call fails, as when Firestore is unreachable.
function unavailableMemoryStore() {
  return new Proxy(
    {},
    {
      get: () => async () => {
        const error = new Error("Firestore unavailable");
        error.code = "FIRESTORE_UNAVAILABLE";
        error.status = 503;
        throw error;
      },
    },
  );
}
const { createGitHubSession } =
  await import("../src/services/githubOAuthService.js");
const ownerSession = await createGitHubSession(
  { access_token: "test-owner-token" },
  async () =>
    new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
      status: 200,
    }),
);
const OWNER_COOKIE = `synchron_github_session=${ownerSession.id}`;

test("Work answers a greeting through a backup engine when Grok fails", async (t) => {
  const previous = {
    AI_CORE_PROVIDER: process.env.AI_CORE_PROVIDER,
    GROK_API_KEY: process.env.GROK_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  Object.assign(process.env, {
    AI_CORE_PROVIDER: "grok",
    GROK_API_KEY: "test-grok-key",
    GEMINI_API_KEY: "test-gemini-key",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const hosts = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const host = new URL(url).hostname;
    hosts.push(host);
    if (host === "api.x.ai") return new Response("", { status: 503 });
    assert.equal(host, "generativelanguage.googleapis.com");
    return Response.json({
      modelVersion: "gemini-test",
      candidates: [{ content: { parts: [{ text: "Добър ден!" }] } }],
    });
  });
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({
      sessionId: "work-greeting-fallback",
      message: "Добър ден",
      mode: "work",
      workContext: { agent: { name: "Код", role: "coder", engine: "codex" } },
    })
    .expect(200);
  assert.deepEqual(hosts, ["api.x.ai", "generativelanguage.googleapis.com"]);
  assert.match(response.text, /Добър ден!/u);
  assert.match(response.text, /"provider":"gemini","model":"gemini-test"/u);
  assert.doesNotMatch(response.text, /event: error|code\.analyze/u);
});

test("Codex is no longer a Council choice", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("no AI call expected");
  });
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({
      sessionId: "work-council-codex",
      message: "Дай кратка оценка.",
      mode: "work",
      council: true,
      councilProviders: ["codex"],
    })
    .expect(200);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.match(response.text, /event: error/u);
  assert.match(response.text, /Невалиден избор на AI двигатели/u);
});

test("chat rejects oversized messages before calling paid AI", async () => {
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({ sessionId: "bounded-chat", message: "x".repeat(6_001) })
    .expect(413);

  assert.equal(response.body.code, "CHAT_MESSAGE_TOO_LONG");
});

test("chat rejects unsafe session identifiers before logging or storage", async () => {
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({ sessionId: "unsafe\nsession", message: "Здравей" })
    .expect(400);

  assert.equal(response.body.code, "CHAT_INVALID_SESSION_ID");
});

test("normal AI chat continues when persistent memory is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  setFirestoreMemoryStoreForTests(unavailableMemoryStore());
  let aiRequest;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      aiRequest = JSON.parse(options.body);
    }
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Работя нормално." }],
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "resilience-test",
        message: "Да.",
        recentHistory: [
          { role: "user", content: "Предложи една проверка." },
          {
            role: "assistant",
            content: "Предлагам проверка на чата. Да я изпълня ли?",
          },
        ],
      })
      .expect(200);

    assert.match(response.text, /Работя нормално\./u);
    assert.deepEqual(
      aiRequest.input.slice(-3).map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "Предложи една проверка." },
        {
          role: "assistant",
          content: "Предлагам проверка на чата. Да я изпълня ли?",
        },
        { role: "user", content: "Да." },
      ],
    );
    assert.match(response.text, /"memoryAvailable":false/u);
    assert.match(response.text, /"conversationPersisted":false/u);
    assert.match(response.text, /"warningCode":"CONVERSATION_NOT_SAVED"/u);
    assert.match(response.text, /event: done/u);
  } finally {
    globalThis.fetch = originalFetch;
    setFirestoreMemoryStoreForTests(null);
  }
});

test("normal chat emits a bounded memory candidate without writing it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Разбрах те." }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 503 });
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "memory-candidate-route",
        message: "Казвам се Радко.",
      })
      .expect(200);

    assert.match(
      response.text,
      /"memoryCandidates":\[\{"fact":"Казвам се Радко","scope":"personal"/u,
    );
    assert.match(response.text, /"memoryCandidateCount":1/u);
    assert.doesNotMatch(response.text, /"memoryUpdated":true/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal chat uses OpenAI Responses without the removed DigitalOcean agent", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    return new Response(
      JSON.stringify({
        model: "gpt-5.6-terra-verified",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Отговор от OpenAI." }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "openai-primary-test", message: "Здравей" })
      .expect(200);

    assert.match(response.text, /Отговор от OpenAI\./u);
    assert.match(response.text, /"provider":"openai"/u);
    assert.match(response.text, /"model":"gpt-5.6-terra-verified"/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("runtime model question answers from verified OpenAI response metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "gpt-5.6-terra-verified",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Не мога да проверя локалните файлове.",
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "runtime-model-test",
        message: "Кой AI доставчик и кой модел използва този разговор?",
      })
      .expect(200);

    assert.match(
      response.text,
      /Този отговор реално е обработен от openai · gpt-5\.6-terra-verified\./u,
    );
    assert.doesNotMatch(response.text, /Не мога да проверя локалните файлове/u);
    assert.match(response.text, /"provider":"openai"/u);
    assert.match(response.text, /"model":"gpt-5.6-terra-verified"/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal chat does not call the removed DigitalOcean agent when OpenAI is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  const calledUrls = [];

  globalThis.fetch = async (url) => {
    calledUrls.push(String(url));
    return new Response("temporary failure", { status: 503 });
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "digitalocean-fallback-test", message: "Здравей" })
      .expect(200);

    assert.equal(calledUrls.length, 1);
    assert.match(calledUrls[0], /api\.openai\.com\/v1\/responses/u);
    assert.match(response.text, /Връзката с AI ядрото/u);
    assert.doesNotMatch(response.text, /"provider":"digitalocean"/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("verified GitHub results bypass AI rewriting", async () => {
  const originalFetch = globalThis.fetch;
  let openAiCalls = 0;
  let githubCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("api.openai.com/v1/responses")) {
      openAiCalls += 1;
      const body = JSON.parse(options.body);
      if (body.model === "gpt-4.1-mini") {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: '{"calls":[{"capability":"code.read","request":"Покажи последния commit в GitHub."}]}',
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error("Verified GitHub output must not be sent back to AI.");
    }

    if (String(url).includes("api.github.com/repos/")) {
      githubCalls += 1;
      assert.equal(options.headers.Authorization, "Bearer test-owner-token");
      return new Response(
        JSON.stringify([
          {
            sha: "abc123456789",
            html_url: "https://github.com/example/repo/commit/abc123456789",
            commit: {
              message: "Agentic result",
              author: { name: "Synchron", date: "2026-07-27T12:00:00Z" },
            },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "agentic-tool-test",
        message: "Покажи последния commit в GitHub.",
      })
      .expect(200);

    assert.equal(openAiCalls, 1);
    assert.equal(githubCalls, 1);
    assert.match(response.text, /Последната реална промяна в GitHub е/u);
    assert.match(response.text, /abc1234 — Agentic result/u);
    assert.match(response.text, /"mode":"verified-tool-output"/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit GitHub request still runs when the AI planner returns no tools", async () => {
  const originalFetch = globalThis.fetch;
  let plannerCalls = 0;
  let githubCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("api.openai.com/v1/responses")) {
      const body = JSON.parse(options.body);
      if (body.model === "gpt-5.6-luna") {
        plannerCalls += 1;
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: '{"calls":[]}' }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error("Verified GitHub output must not be sent back to AI.");
    }

    if (String(url).includes("api.github.com/repos/")) {
      githubCalls += 1;
      return new Response(
        JSON.stringify([
          {
            sha: "planner-safe123456",
            html_url:
              "https://github.com/example/repo/commit/planner-safe123456",
            commit: {
              message: "Planner cannot suppress tools",
              author: { name: "Synchron", date: "2026-07-27T12:00:00Z" },
            },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "planner-empty-github-test",
        message: "Провери хъба.",
      })
      .expect(200);

    assert.equal(plannerCalls, 0);
    assert.equal(githubCalls, 1);
    assert.match(response.text, /Последната реална промяна в GitHub е/u);
    assert.match(response.text, /Planner cannot suppress tools/u);
    assert.match(response.text, /"mode":"verified-tool-output"/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit memory writes fail safely when memory is unavailable", async () => {
  setFirestoreMemoryStoreForTests(unavailableMemoryStore());
  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "resilience-memory-test",
        message: "Запомни, че любимият ми цвят е син.",
      })
      .expect(503);

    assert.match(response.body.error, /Нищо не беше записано или изтрито/u);
  } finally {
    setFirestoreMemoryStoreForTests(null);
  }
});

test("independent tools still run when the OpenAI key is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.github\.com\/repos\//u);
    return new Response(
      JSON.stringify([
        {
          sha: "abc123456789",
          html_url: "https://github.com/example/repo/commit/abc123456789",
          commit: {
            message: "Working tool without agent",
            author: { name: "Synchron", date: "2026-07-27T12:00:00Z" },
          },
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({
        sessionId: "tool-without-agent-test",
        message:
          "Покажи последния commit в GitHub хранилището radostinvgeorgiev-commits/sunchron-backend.",
      })
      .expect(200);

    assert.match(response.text, /Working tool without agent/u);
    assert.match(response.text, /event: done/u);
    assert.doesNotMatch(response.text, /AI разговорът временно/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("normal chat reports only the missing AI connection", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "missing-agent-test", message: "Здравей" })
      .expect(200);

    assert.match(response.text, /event: error/u);
    assert.match(response.text, /AI разговорът временно не е конфигуриран/u);
    assert.match(response.text, /Независимите инструменти остават достъпни/u);
  } finally {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("Work uses stored project conversations and ignores client-provided links", async (t) => {
  const { setFirestoreWorkspaceStoreForTests } =
    await import("../src/services/workspaceStateService.js");
  const { setFirestoreMemoryStoreForTests } =
    await import("../src/services/memoryService.js");
  const { resolveMemoryOwnerId } =
    await import("../src/middleware/ownerAuth.js");
  const ownerId = resolveMemoryOwnerId("radostinvgeorgiev-commits");
  const keys = ["MEMORY_BACKEND", "PERSISTENCE_BACKEND"];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "firestore";
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    setFirestoreWorkspaceStoreForTests(null);
    setFirestoreMemoryStoreForTests(null);
  });
  setFirestoreWorkspaceStoreForTests({
    get: async () => ({
      data: {
        state: {
          projects: [
            {
              id: "project-launch",
              name: "Launch",
              decisions: ["Срокът е петък."],
              conversationIds: ["linked-chat", "current-chat"],
            },
          ],
        },
      },
    }),
  });
  const reads = [];
  setFirestoreMemoryStoreForTests({
    listProfileDocuments: async () => [],
    listConversationSessionDocuments: async (owner, id) => {
      assert.equal(owner, ownerId);
      reads.push(id);
      const messages =
        id === "current-chat"
          ? ["По-стара заявка от текущия чат.", "Последен запазен отговор."]
          : ["Синият файл е одобрен.", "Възстановявам бележката."];
      return messages.map((content, index) => ({
        id: `${id}-${index}`,
        data: {
          role: index ? "assistant" : "user",
          content,
          createdAt: `2026-11-21T00:00:0${index}Z`,
        },
      }));
    },
    commitConversationDocuments: async () => {},
  });
  let input;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    input = JSON.parse(options.body).input;
    return Response.json({ output_text: "Проектът е в срок." });
  });
  const result = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({
      mode: "work",
      sessionId: "current-chat",
      message: "Обобщи контекста.",
      workContext: {
        project: {
          id: "project-launch",
          name: "Launch",
          conversationIds: ["unlinked-chat"],
        },
      },
      recentHistory: [
        { role: "assistant", content: "Последен запазен отговор." },
        { role: "user", content: "По-нова незаписана бележка." },
      ],
    })
    .expect(200);
  assert.match(result.text, /event: done/u);
  assert.deepEqual(reads, ["current-chat", "linked-chat"]);
  assert.match(result.text, /"linkedProjectContext":true/u);
  assert.equal(input[1].content, "По-стара заявка от текущия чат.");
  assert.equal(
    input.filter(({ content }) => content === "Последен запазен отговор.")
      .length,
    1,
  );
  assert.match(input.at(-2).content, /Синият файл е одобрен\./u);
  assert.match(input.at(-2).content, /Срокът е петък\./u);
  assert.equal(input.at(-1).content, "Обобщи контекста.");
});

test("Work keeps trying available models when a selected model fails and another times out", async (t) => {
  const config = {
    AI_CORE_PROVIDER: "grok",
    OPENAI_CHAT_MODEL: "gpt-5.6-terra",
    OPENAI_TIMEOUT_MS: "15",
    GEMINI_API_KEY: "test-gemini",
    GROK_API_KEY: "test-grok",
  };
  const previous = Object.fromEntries(
    Object.keys(config).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const host = new URL(url).hostname;
    calls.push(
      host === "api.openai.com" ? JSON.parse(options.body).model : host,
    );
    if (host === "api.openai.com") {
      if (calls.length === 1) return new Response(null, { status: 404 });
      await new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    }
    if (host === "generativelanguage.googleapis.com")
      return new Response(null, { status: 503 });
    assert.equal(host, "api.x.ai");
    return Response.json({
      model: "grok-test",
      choices: [{ message: { content: "Работният чат отговаря." } }],
    });
  });

  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({
      sessionId: "work-provider-recovery",
      message: "Добър ден",
      mode: "work",
      workContext: {
        project: { name: "Тест" },
        agent: { name: "Личен помощник", model: "gpt-5.6-sol" },
      },
    })
    .expect(200);

  assert.deepEqual(calls, [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "generativelanguage.googleapis.com",
    "api.x.ai",
  ]);
  assert.match(response.text, /Работният чат отговаря\./u);
  assert.match(response.text, /"provider":"grok","model":"grok-test"/u);
  assert.doesNotMatch(response.text, /event: error/u);
});
