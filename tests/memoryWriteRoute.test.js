import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_CORE_PROVIDER = "openai";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
process.env.GITHUB_SESSION_ENCRYPTION_KEY =
  "memory-write-route-test-encryption-key";

const { default: app } = await import("../server.js");
const { createGitHubSession } =
  await import("../src/services/githubOAuthService.js");
const { resetConfirmationsForTests } =
  await import("../src/services/confirmationService.js");
const { listProfileMemories, saveProfileMemory } =
  await import("../src/services/memoryService.js");
const { resetLocalDocumentStoreForTests } =
  await import("../src/services/localDocumentStore.js");

// The personal memory stored for an owner in the local in-process store.
function profileFor(ownerId) {
  return listProfileMemories({ scope: "personal", ownerId });
}

test("chat never persists an ordinary fact and writes an explicit fact only after one-time confirmation", async () => {
  resetLocalDocumentStoreForTests();
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
    assert.deepEqual(await profileFor("primary-user"), []);

    const prepared = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId: "memory-write-route",
        message: "Запомни: Казвам се Иван.",
      })
      .expect(200);
    assert.deepEqual(await profileFor("primary-user"), []);
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
      (await profileFor("primary-user")).map(({ fact, source }) => ({
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
  resetLocalDocumentStoreForTests();
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
    assert.equal((await profileFor("primary-user")).length, 1);
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
    assert.deepEqual(await profileFor("primary-user"), []);

    const replay = await request(app)
      .post("/chat/chat")
      .set("Cookie", ownerCookie)
      .send({
        sessionId,
        message: `Потвърждавам изтриването от постоянната памет: ${confirmationId}`,
      })
      .expect(404);
    assert.equal(replay.body.code, "CONFIRMATION_NOT_FOUND");
    assert.deepEqual(await profileFor("primary-user"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
