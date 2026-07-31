import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
process.env.GITHUB_SESSION_ENCRYPTION_KEY =
  "memory-write-route-test-encryption-key";

const { setOpenSearchClientForTests } =
  await import("../src/config/opensearch.js");
const { default: app } = await import("../server.js");
const { createGitHubSession } =
  await import("../src/services/githubOAuthService.js");

function createMemoryWriteClient() {
  const indexes = new Map();
  const documents = (index) => {
    if (!indexes.has(index)) indexes.set(index, new Map());
    return indexes.get(index);
  };
  const matches = (source, query, id) => {
    const filters = query?.bool?.filter || (query?.term ? [query] : []);
    return filters.every((filter) => {
      if (filter.term) {
        const [field, expected] = Object.entries(filter.term)[0];
        return field === "_id" ? id === expected : source[field] === expected;
      }
      if (filter.terms) {
        const [field, expected] = Object.entries(filter.terms)[0];
        const actual = field === "_id" ? id : source[field];
        return Array.isArray(expected) && expected.includes(actual);
      }
      return true;
    });
  };

  return {
    indices: {
      exists: async () => ({ body: true }),
      putMapping: async () => ({ body: { acknowledged: true } }),
    },
    async search({ index, body }) {
      const hits = [...documents(index)].map(([id, source]) => ({
        _id: id,
        _source: structuredClone(source),
      }));
      return {
        body: {
          hits: {
            hits: hits
              .filter(({ _id, _source }) => matches(_source, body.query, _id))
              .slice(0, body.size || 200),
          },
        },
      };
    },
    async index({ index, id, body }) {
      documents(index).set(id, structuredClone(body));
      return { body: { result: "created" } };
    },
    async get({ index, id }) {
      const source = documents(index).get(id);
      if (!source) {
        const error = new Error("not found");
        error.statusCode = 404;
        throw error;
      }
      return { body: { _source: structuredClone(source) } };
    },
    async delete({ index, id }) {
      documents(index).delete(id);
      return { body: { result: "deleted" } };
    },
    async bulk({ body }) {
      for (let cursor = 0; cursor < body.length; cursor += 1) {
        const operation = body[cursor];
        if (operation.delete) {
          documents(operation.delete._index).delete(operation.delete._id);
          continue;
        }
        if (operation.index) {
          documents(operation.index._index).set(
            operation.index._id,
            structuredClone(body[cursor + 1]),
          );
          cursor += 1;
        }
      }
      return { body: { errors: false } };
    },
    async deleteByQuery({ index, body }) {
      let deleted = 0;
      for (const [id, source] of documents(index)) {
        if (matches(source, body.query, id)) {
          documents(index).delete(id);
          deleted += 1;
        }
      }
      return { body: { deleted } };
    },
    profileFor(ownerId) {
      return [...documents("synchron-profile-memory-v1").values()].filter(
        (item) => item.ownerId === ownerId,
      );
    },
  };
}

test("chat never persists an ordinary fact and writes an explicit fact only after one-time confirmation", async () => {
  const client = createMemoryWriteClient();
  setOpenSearchClientForTests(client);
  const ownerSession = await createGitHubSession(
    { access_token: "test-owner-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
  const ownerCookie = `synchron_github_session=${ownerSession.id}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Разбрах." }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-write-route",
        message: "Казвам се Иван и живея във Варна.",
      })
      .expect(200);
    assert.deepEqual(client.profileFor("primary-user"), []);

    const prepared = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-write-route",
        message: "Запомни: Казвам се Иван.",
      })
      .expect(200);
    assert.deepEqual(client.profileFor("primary-user"), []);
    const confirmationId = prepared.text.match(
      /Потвърждавам постоянен запис:\s*([0-9a-f-]{36})/iu,
    )?.[1];
    assert.ok(confirmationId);

    const confirmed = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-write-route",
        message: `Потвърждавам постоянен запис: ${confirmationId}`,
      })
      .expect(200);
    assert.match(confirmed.text, /Запомних: Казвам се Иван/u);
    assert.deepEqual(
      client.profileFor("primary-user").map(({ fact, source }) => ({
        fact,
        source,
      })),
      [{ fact: "Казвам се Иван", source: "confirmed-chat-command" }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat prepares a durable exact delete and executes it once", async () => {
  const client = createMemoryWriteClient();
  setOpenSearchClientForTests(client);
  const { saveProfileMemory } = await import(
    "../src/services/memoryService.js"
  );
  await saveProfileMemory(
    "Тестов факт за изтриване",
    "test-fixture",
    "personal",
    "primary-user",
  );
  const ownerSession = await createGitHubSession(
    { access_token: "test-owner-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
  const ownerCookie = `synchron_github_session=${ownerSession.id}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Разбрах." }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const prepared = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-delete-route",
        message:
          "Изтрий от постоянната памет само: Тестов факт за изтриване",
      })
      .expect(200);
    assert.equal(client.profileFor("primary-user").length, 1);
    const confirmationId = prepared.text.match(
      /Потвърждавам изтриване от постоянната памет:\s*([0-9a-f-]{36})/iu,
    )?.[1];
    assert.ok(confirmationId);

    await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({ sessionId: "memory-delete-route", message: "Да" })
      .expect(200);
    assert.equal(client.profileFor("primary-user").length, 1);

    const confirmed = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-delete-route",
        message: `Потвърждавам изтриване от постоянната памет: ${confirmationId}`,
      })
      .expect(200);
    assert.match(confirmed.text, /Забравих: Тестов факт за изтриване/u);
    assert.deepEqual(client.profileFor("primary-user"), []);

    const replay = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-delete-route",
        message: `Потвърждавам изтриване от постоянната памет: ${confirmationId}`,
      })
      .expect(200);
    assert.match(replay.text, /вече е изтекло|не е намерено/iu);
    assert.deepEqual(client.profileFor("primary-user"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
