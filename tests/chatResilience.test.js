import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.AGENT_KEY = "test-agent-key";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
delete process.env.OPENSEARCH_HOST;
delete process.env.OPENSEARCH_USERNAME;
delete process.env.OPENSEARCH_PASSWORD;

const { default: app } = await import("../server.js");
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

test("normal AI chat continues when persistent memory is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"Работя нормално."}}]}\n\n' +
        "data: [DONE]\n\n",
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "resilience-test", message: "Здравей" })
      .expect(200);

    assert.match(response.text, /Работя нормално\./u);
    assert.match(response.text, /"memoryAvailable":false/u);
    assert.match(response.text, /event: done/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal chat uses OpenAI Responses before the DigitalOcean fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  let digitalOceanCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v1/chat/completions")) {
      digitalOceanCalls += 1;
      throw new Error("DigitalOcean should be a fallback only.");
    }
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    return new Response(
      JSON.stringify({
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

    assert.equal(digitalOceanCalls, 0);
    assert.match(response.text, /Отговор от OpenAI\./u);
    assert.match(response.text, /"provider":"openai"/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("normal chat falls back to DigitalOcean when OpenAI is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  const calledUrls = [];

  globalThis.fetch = async (url) => {
    calledUrls.push(String(url));
    if (String(url).includes("api.openai.com")) {
      return new Response("temporary failure", { status: 503 });
    }
    if (String(url).includes("/api/v1/chat/completions")) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"Резервният агент работи."}}]}\n\n' +
          "data: [DONE]\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "digitalocean-fallback-test", message: "Здравей" })
      .expect(200);

    assert.equal(calledUrls.length, 2);
    assert.match(response.text, /Резервният агент работи\./u);
    assert.match(response.text, /"provider":"digitalocean"/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("tool results return to the AI core for one synthesized answer", async () => {
  const originalFetch = globalThis.fetch;
  let agentCalls = 0;
  let githubCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v1/chat/completions")) {
      agentCalls += 1;
      const body = JSON.parse(options.body);
      if (body.stream === false) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"calls":[{"capability":"code.read","request":"Покажи последния commit в GitHub."}]}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      assert.match(body.messages[0].content, /РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ/u);
      assert.match(body.messages[0].content, /abc1234/u);
      return new Response(
        'data: {"choices":[{"delta":{"content":"Проверих GitHub. Последният commit е abc1234."}}]}\n\n' +
          "data: [DONE]\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }

    if (String(url).includes("api.github.com/repos/")) {
      githubCalls += 1;
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

    assert.equal(agentCalls, 2);
    assert.equal(githubCalls, 1);
    assert.match(
      response.text,
      /Проверих GitHub\. Последният commit е abc1234\./u,
    );
    assert.match(response.text, /"mode":"agentic"/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit GitHub request still runs when the AI planner returns no tools", async () => {
  const originalFetch = globalThis.fetch;
  let plannerCalls = 0;
  let githubCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v1/chat/completions")) {
      const body = JSON.parse(options.body);
      if (body.stream === false) {
        plannerCalls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"calls":[]}' } }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      assert.match(body.messages[0].content, /РЕЗУЛТАТИ ОТ ИНСТРУМЕНТИ/u);
      assert.match(body.messages[0].content, /Planner cannot suppress tools/u);
      return new Response(
        'data: {"choices":[{"delta":{"content":"Проверих GitHub успешно."}}]}\n\n' +
          "data: [DONE]\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
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

    assert.equal(plannerCalls, 1);
    assert.equal(githubCalls, 1);
    assert.match(response.text, /Проверих GitHub успешно\./u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit memory writes fail safely when memory is unavailable", async () => {
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({
      sessionId: "resilience-memory-test",
      message: "Запомни, че любимият ми цвят е син.",
    })
    .expect(503);

  assert.match(response.body.error, /Нищо не беше записано или изтрито/u);
});

test("independent tools still run when the AI agent key is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalAgentKey = process.env.AGENT_KEY;
  delete process.env.AGENT_KEY;
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
    if (originalAgentKey === undefined) delete process.env.AGENT_KEY;
    else process.env.AGENT_KEY = originalAgentKey;
  }
});

test("normal chat reports only the missing AI connection", async () => {
  const originalAgentKey = process.env.AGENT_KEY;
  delete process.env.AGENT_KEY;

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
    if (originalAgentKey === undefined) delete process.env.AGENT_KEY;
    else process.env.AGENT_KEY = originalAgentKey;
  }
});
