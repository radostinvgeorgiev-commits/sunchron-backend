import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
delete process.env.OPENSEARCH_HOST;
delete process.env.OPENSEARCH_USERNAME;
delete process.env.OPENSEARCH_PASSWORD;

const { default: app } = await import("../server.js");
const { createGitHubSession } =
  await import("../src/services/githubOAuthService.js");

test("keeps liveness and sign-in routes public", async () => {
  await request(app).get("/health").expect(200);
  await request(app).get("/").set("Host", "synchron.foundation").expect(200);
  const registration = await request(app).get("/register").expect(200);
  assert.match(registration.text, /id="registerForm"/u);
  const config = await request(app).get("/api/public-config").expect(200);
  assert.equal(config.body.chatgptWorkUrl, "https://chatgpt.com/");
  const auth = await request(app).get("/api/auth/session").expect(200);
  assert.equal(auth.body.authenticated, false);
  const status = await request(app).get("/api/github/status").expect(200);
  assert.equal(status.body.connected, false);
});

test("blocks personal data and paid AI routes without owner sign-in", async () => {
  const routes = [
    ["get", "/memory/conversations"],
    ["get", "/calendar/events"],
    ["get", "/api/tester-auth/status"],
    ["get", "/api/system/configuration"],
    ["get", "/api/workspaces"],
    ["put", "/api/workspaces"],
    ["get", "/permissions/audit"],
    ["post", "/search/ai"],
    ["post", "/chat/chat"],
  ];

  for (const [method, path] of routes) {
    const response = await request(app)[method](path).send({});
    assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  }
});

test("allows the verified repository owner through the private boundary", async () => {
  const session = await createGitHubSession(
    { access_token: "test-owner-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );

  const response = await request(app)
    .get("/memory/conversations")
    .set("Cookie", `synchron_github_session=${session.id}`);

  assert.notEqual(response.status, 401);
});
