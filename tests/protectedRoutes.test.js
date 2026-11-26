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
  const publicEntry = await request(app)
    .get("/")
    .set("Host", "cloudaicore.com")
    .expect(200);
  assert.match(publicEntry.text, /AI CORE/u);
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
    ["get", "/api/tasks"],
    ["post", "/api/tasks"],
    ["post", "/api/tasks/status/confirm"],
    ["get", "/api/task-runs"],
    ["post", "/api/task-runs"],
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

test("GitHub API reads use the verified owner OAuth session", async () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.GITHUB_API_URL;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.GITHUB_TOKEN = "configured-read-token";
  const session = await createGitHubSession(
    { access_token: "oauth-router-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer oauth-router-token");
    return new Response(
      JSON.stringify({
        full_name: "radostinvgeorgiev-commits/sunchron-backend",
        default_branch: "main",
        private: true,
        html_url: "https://github.test/repository",
      }),
      { status: 200 },
    );
  };

  try {
    const response = await request(app)
      .get("/github/status")
      .set("Cookie", `synchron_github_session=${session.id}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.private, true);
  } finally {
    global.fetch = originalFetch;
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
