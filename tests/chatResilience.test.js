import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.AGENT_KEY = "test-agent-key";
delete process.env.OPENSEARCH_HOST;
delete process.env.OPENSEARCH_USERNAME;
delete process.env.OPENSEARCH_PASSWORD;

const { default: app } = await import("../server.js");

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
      .send({ sessionId: "resilience-test", message: "Здравей" })
      .expect(200);

    assert.match(response.text, /Работя нормално\./u);
    assert.match(response.text, /"memoryAvailable":false/u);
    assert.match(response.text, /event: done/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit memory writes fail safely when memory is unavailable", async () => {
  const response = await request(app)
    .post("/chat/chat")
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
