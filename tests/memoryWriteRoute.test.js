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
const { resetConfirmationsForTests } =
  await import("../src/services/confirmationService.js");
const { saveProfileMemory } = await import("../src/services/memoryService.js");

function createMemoryWriteClient() {
  const indexes = new Map();
  const documents = (index) => {
    if (!indexes.has(index)) indexes.set(index, new Map());
    return indexes.get(index);
  };
  const matches = (id, source, query) => {
    const filters = query?.bool?.filter || (query?.term ? [query] : []);
    return filters.every((filter) => {
      if (filter.term) {
        const [field, expected] = Object.entries(filter.term)[0];
        return field === "_id" ? id === expected : source[field] === expected;
      }
      if (filter.terms?._id) return filter.terms._id.includes(id);
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
              .filter(({ _id, _source }) => matches(_id, _source, body.query))
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
      for (const [id, source] of [...documents(index)]) {
        if (!matches(id, source, body.query)) continue;
        documents(index).delete(id);
        deleted += 1;
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
    const ordinaryResponse = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-write-route",
        message: "Казвам се Иван и живея във Варна.",
      })
      .expect(200);
    assert.match(ordinaryResponse.text, /"conversationPersisted":true/u);
    assert.doesNotMatch(ordinaryResponse.text, /CONVERSATION_NOT_SAVED/u);
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

test("chat deletes only after a durable UUID confirmation and blocks replay", async () => {
  resetConfirmationsForTests();
  const client = createMemoryWriteClient();
  setOpenSearchClientForTests(client);
  await saveProfileMemory(
    "Факт за устойчиво изтриване",
    "test-seed",
    "personal",
    "primary-user",
  );
  const ownerSession = await createGitHubSession(
    { access_token: "test-owner-token-delete" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
  const ownerCookie = `synchron_github_session=${ownerSession.id}`;
  const sessionId = "memory-delete-route";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"calls":[]}' }],
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
        sessionId,
        message:
          "Потвърждавам изтриването от постоянната памет само на факта: Факт за устойчиво изтриване",
      })
      .expect(200);
    assert.equal(client.profileFor("primary-user").length, 1);
    const confirmationId = prepared.text.match(
      /Потвърждавам изтриването от постоянната памет:\s*([0-9a-f-]{36})/iu,
    )?.[1];
    assert.ok(confirmationId);

    resetConfirmationsForTests();
    const confirmed = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId,
        message: `Потвърждавам изтриването от постоянната памет: ${confirmationId}`,
      })
      .expect(200);
    assert.match(confirmed.text, /Забравих: Факт за устойчиво изтриване/u);
    assert.deepEqual(client.profileFor("primary-user"), []);

    const replay = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId,
        message: `Потвърждавам изтриването от постоянната памет: ${confirmationId}`,
      })
      .expect(404);
    assert.equal(replay.body.code, "CONFIRMATION_NOT_FOUND");
    assert.deepEqual(client.profileFor("primary-user"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
