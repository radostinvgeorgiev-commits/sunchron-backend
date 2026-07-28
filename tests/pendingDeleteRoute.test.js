/**
 * Route-level integration tests for pending-delete denial and OpenSearch failure.
 *
 * These tests exercise the actual chat route handler to verify that:
 * 1. A "Не"/"Отказвам" reply with an active pending delete clears the pending
 *    entry and returns a clear cancellation message (SSE 200).
 * 2. When OpenSearch is unavailable and the user confirms with "Да", the route
 *    returns 503 and the pending entry is preserved for a later retry.
 */

import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.GITHUB_REPOSITORY =
  "radostinvgeorgiev-commits/sunchron-backend";
// OpenSearch is intentionally absent so deletion attempts fail.
delete process.env.OPENSEARCH_HOST;
delete process.env.OPENSEARCH_USERNAME;
delete process.env.OPENSEARCH_PASSWORD;

const { default: app } = await import("../server.js");
const { createGitHubSession } = await import(
  "../src/services/githubOAuthService.js",
);
const {
  getPendingDelete,
  resetPendingDeletesForTests,
  storePendingDelete,
} = await import("../src/services/pendingDeleteService.js");

const ownerSession = await createGitHubSession(
  { access_token: "test-owner-token" },
  async () =>
    new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
      status: 200,
    }),
);
const OWNER_COOKIE = `synchron_github_session=${ownerSession.id}`;

// ---------------------------------------------------------------------------
// Test 1: denial via route clears the pending entry
// ---------------------------------------------------------------------------

test("route: 'Не' with active pending delete returns cancellation reply and clears pending", async () => {
  resetPendingDeletesForTests();
  const sessionId = "route-deny-test";
  const fact = "Тестов факт за отказ от маршрута";

  // Inject a pending delete as the chat route would after a delete-confirmation-
  // required memoryAction.
  storePendingDelete(sessionId, fact, "personal");
  assert.ok(getPendingDelete(sessionId), "pending must be set before request");

  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({ sessionId, message: "Не" })
    .expect(200);

  // The route returns SSE.  The cancellation token must be present.
  assert.match(
    response.text,
    /event: token/u,
    "response must be SSE with a token event",
  );
  assert.match(
    response.text,
    /[Оо]тмен/u,
    "token must contain the cancellation message",
  );
  assert.match(response.text, /event: done/u, "response must end with done");

  // Most importantly: the pending entry must be cleared by the route.
  assert.equal(
    getPendingDelete(sessionId),
    null,
    "pending must be cleared after denial",
  );
});

// ---------------------------------------------------------------------------
// Test 2: later "Да" after denial does not trigger deletion (route-level)
// ---------------------------------------------------------------------------

test("route: 'Да' after denial has no pending entry and does not return 503", async () => {
  resetPendingDeletesForTests();
  const sessionId = "route-deny-then-yes-test";

  // No pending set — simulates the state after a denial cleared it.
  assert.equal(getPendingDelete(sessionId), null, "no pending before request");

  // A bare "Да" without a pending entry is not an explicit memory intent,
  // so the route will try to forward it to the AI agent.  Because the agent
  // key is not set in the test environment the route returns an SSE error
  // event (not 503).
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({ sessionId, message: "Да" })
    .expect(200);

  // The route must NOT return the memory-unavailable 503.
  assert.notEqual(response.status, 503, "must not be a memory 503");
  // And the response must be SSE (AI path), not a JSON memory reply.
  assert.match(response.text, /event:/u, "response must be SSE");

  // No pending created or left.
  assert.equal(getPendingDelete(sessionId), null);
});

// ---------------------------------------------------------------------------
// Test 3: OpenSearch failure on confirmation preserves pending for retry
// ---------------------------------------------------------------------------

test("route: 'Да' with pending when OpenSearch is unavailable returns 503 and preserves pending", async () => {
  resetPendingDeletesForTests();
  const sessionId = "route-opensearch-fail-test";
  const fact = "Тестов факт за OpenSearch грешка";

  storePendingDelete(sessionId, fact, "personal");
  assert.ok(getPendingDelete(sessionId), "pending must be set before request");

  // OpenSearch is not configured (env vars deleted above), so
  // deleteProfileMemoryByFact will throw and the route must return 503
  // without clearing the pending entry.
  const response = await request(app)
    .post("/chat/chat")
    .set("Cookie", OWNER_COOKIE)
    .send({ sessionId, message: "Да" })
    .expect(503);

  assert.match(
    response.body.error,
    /Нищо не беше записано или изтрито/u,
    "503 body must contain the expected error message",
  );

  // Critical: pending must survive the failure so the user can retry.
  const preserved = getPendingDelete(sessionId);
  assert.ok(preserved, "pending must be preserved after OpenSearch failure");
  assert.equal(
    preserved.fact,
    fact,
    "preserved pending must hold the original fact",
  );
});
