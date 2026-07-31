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
const { setOpenSearchClientForTests } =
  await import("../src/config/opensearch.js");
const { createGitHubSession } =
  await import("../src/services/githubOAuthService.js");

function createProfileClient() {
  const profile = new Map([
    [
      "owner-profile",
      {
        ownerId: "primary-user",
        fact: "Предпочитам конкретен резултат и кратко обяснение",
        normalizedFact: "предпочитам конкретен резултат и кратко обяснение",
        memoryKey: "personal:preference:working-style",
        category: "preference",
        scope: "personal",
        source: "test",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  ]);
  const conversations = new Map();

  function documents(index) {
    return index.includes("conversation") ? conversations : profile;
  }

  function matches(source, query = {}) {
    const filters = query.bool?.filter || (query.term ? [query] : []);
    return filters.every((filter) => {
      const [field, expected] = Object.entries(filter.term || {})[0] || [];
      return field ? source[field] === expected : true;
    });
  }

  return {
    indices: {
      exists: async () => ({ body: true }),
      putMapping: async () => ({ body: { acknowledged: true } }),
    },
    async search({ index, body }) {
      const hits = [...documents(index).entries()]
        .map(([id, source]) => ({ _id: id, _source: source }))
        .filter(({ _source }) => matches(_source, body.query))
        .sort((left, right) =>
          String(
            right._source.updatedAt || right._source.createdAt,
          ).localeCompare(
            String(left._source.updatedAt || left._source.createdAt),
          ),
        );
      return { body: { hits: { hits: hits.slice(0, body.size || 200) } } };
    },
    async index({ index, id, body }) {
      documents(index).set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async bulk({ body }) {
      for (let index = 0; index < body.length; index += 2) {
        const operation = body[index]?.index;
        if (operation) {
          documents(operation._index).set(
            operation._id,
            structuredClone(body[index + 1]),
          );
        }
      }
      return { body: { errors: false } };
    },
  };
}

const ownerSession = await createGitHubSession(
  { access_token: "test-owner-token" },
  async () =>
    new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
      status: 200,
    }),
);
const OWNER_COOKIE = `synchron_github_session=${ownerSession.id}`;

test("every real chat request sends Core Profile and owner memory to OpenAI", async () => {
  setOpenSearchClientForTests(createProfileClient());
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
      ["core-profile-first", "Какво е SYNCHRON-X?"],
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
    assert.equal(input.length, 1);
    assert.equal(input[0].role, "user");
    assert.match(
      input[0].content,
      /\[ПОСТОЯНЕН ОСНОВЕН КОНТЕКСТ НА ПРОЕКТА\]/u,
    );
    assert.match(
      input[0].content,
      /СЪЗВУК е лична AI операционна система/u,
    );
    assert.match(input[0].content, /\[ЛИЧЕН ПРОФИЛ НА РАДКО\]/u);
    assert.match(
      input[0].content,
      /Предпочитам конкретен резултат и кратко обяснение/u,
    );
    assert.match(
      input[0].content,
      new RegExp(
        index === 0
          ? "Какво е SYNCHRON-X\\?"
          : "Как работим по техническа задача\\?",
        "u",
      ),
    );
  }
});
