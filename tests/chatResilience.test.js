import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
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

  try {
    const response = await request(app)
      .post("/chat/chat")
      .set("Cookie", OWNER_COOKIE)
      .send({ sessionId: "resilience-test", message: "Здравей" })
      .expect(200);

    assert.match(response.text, /Работя нормално\./u);
    assert.match(response.text, /"memoryAvailable":false/u);
    assert.match(response.text, /"conversationPersisted":false/u);
    assert.match(response.text, /"warningCode":"CONVERSATION_NOT_SAVED"/u);
    assert.match(response.text, /event: done/u);
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
      if (body.model === "gpt-5.6-luna") {
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

    assert.equal(plannerCalls, 1);
    assert.equal(githubCalls, 1);
    assert.match(response.text, /Последната реална промяна в GitHub е/u);
    assert.match(response.text, /Planner cannot suppress tools/u);
    assert.match(response.text, /"mode":"verified-tool-output"/u);
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
