import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_CORE_PROVIDER = "openai";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";

const { default: app } = await import("../server.js");
const { saveProfileMemory } = await import("../src/services/memoryService.js");
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

test("every real chat request sends Core Profile and owner memory to OpenAI", async () => {
  await saveProfileMemory(
    "Предпочитам конкретен резултат и кратко обяснение",
    "test",
    "personal",
    "primary-user",
  );
  const originalFetch = globalThis.fetch;
  const openAiInputs = [];

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    openAiInputs.push(body.input);
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Проверен отговор." }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    for (const [sessionId, message] of [
      ["core-profile-first", "Какво е Novarium?"],
      ["core-profile-second", "Как работим по техническа задача?"],
    ]) {
      const response = await request(app)
        .post("/chat/chat")
        .set("Cookie", OWNER_COOKIE)
        .send({ sessionId, message })
        .expect(200);

      assert.match(response.text, /Проверен отговор\./u);
      assert.match(response.text, /"memoryAvailable":true/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(openAiInputs.length, 2);
  for (const [index, input] of openAiInputs.entries()) {
    assert.equal(input.length, 2);
    assert.equal(input[0].role, "system");
    assert.equal(input[1].role, "user");
    assert.match(
      input[0].content,
      /\[ПОСТОЯНЕН ОСНОВЕН КОНТЕКСТ НА ПРОЕКТА\]/u,
    );
    assert.match(input[0].content, /Novarium е лична AI операционна система/u);
    assert.match(input[0].content, /\[ЛИЧЕН ПРОФИЛ НА РАДКО\]/u);
    assert.match(
      input[0].content,
      /Предпочитам конкретен резултат и кратко обяснение/u,
    );
    assert.equal(
      input[1].content,
      index === 0 ? "Какво е Novarium?" : "Как работим по техническа задача?",
    );
  }
});
