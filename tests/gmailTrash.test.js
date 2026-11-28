import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";

const { createSession, resetGoogleSessionsForTests } = await import("../src/services/googleDriveService.js");
const { default: googleDriveRouter } = await import("../src/routes/googleDriveRouter.js");

const maria = { memoryOwnerId: "user:maria", role: "member" };
const ivan = { memoryOwnerId: "user:ivan", role: "member" };

function appFor(owner) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use("/api/google", googleDriveRouter);
  return app;
}

// Every person moves their own letters to the Gmail bin from the Gmail panel
// (review of #605: the bin had been the owner's only, through the connector).
test("a member moves their own letter to the bin with their own Google", async () => {
  resetGoogleSessionsForTests();
  const mine = await createSession({ access_token: "maria-token", expires_in: 3600 }, maria);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", auth: options.headers?.Authorization });
    if (String(url).endsWith("/trash")) {
      return new Response(JSON.stringify({ id: "msg-1", labelIds: ["TRASH"] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        id: "msg-1",
        payload: { headers: [{ name: "From", value: "Банка <bank@example.com>" }, { name: "Subject", value: "Извлечение" }] },
      }),
      { status: 200 },
    );
  };
  try {
    const response = await request(appFor(maria))
      .post("/api/google/gmail/trash")
      .set("Cookie", `synchron_google_session=${mine}`)
      .send({ messageId: "msg-1" })
      .expect(200);
    assert.deepEqual(response.body, {
      trashed: true,
      message: { id: "msg-1", subject: "Извлечение", from: "Банка <bank@example.com>" },
    });
    assert.deepEqual(
      calls.map(({ method, url, auth }) => [method, url.replace(/\?.*$/u, ""), auth]),
      [
        ["GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1", "Bearer maria-token"],
        ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1/trash", "Bearer maria-token"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("another person's Google connection never moves a letter", async () => {
  resetGoogleSessionsForTests();
  const mine = await createSession({ access_token: "maria-token", expires_in: 3600 }, maria);
  let called = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await request(appFor(ivan))
      .post("/api/google/gmail/trash")
      .set("Cookie", `synchron_google_session=${mine}`)
      .send({ messageId: "msg-1" })
      .expect(401);
    assert.equal(response.body.code, "GOOGLE_NOT_CONNECTED");
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Second review of #605: without Gmail's modify permission the panel gets a
// plain sentence and the link that adds it, never raw link text.
test("a missing Gmail permission answers with its own sentence and the link that adds it", async () => {
  resetGoogleSessionsForTests();
  const mine = await createSession({ access_token: "maria-token", expires_in: 3600 }, maria);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/trash")) {
      return new Response(
        JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }], message: "Request had insufficient authentication scopes." } }),
        { status: 403 },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg-1",
        payload: { headers: [{ name: "From", value: "Банка <bank@example.com>" }, { name: "Subject", value: "Извлечение" }] },
      }),
      { status: 200 },
    );
  };
  try {
    const response = await request(appFor(maria))
      .post("/api/google/gmail/trash")
      .set("Cookie", `synchron_google_session=${mine}`)
      .send({ messageId: "msg-1" })
      .expect(403);
    assert.deepEqual(response.body, {
      error: "Преместването в кошчето иска още едно разрешение за Gmail.",
      code: "GOOGLE_SCOPE_REQUIRED",
      connect: "/api/google/connect?add=gmail",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
