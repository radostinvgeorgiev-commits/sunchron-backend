import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubAuthorizationUrl,
  createGitHubSession,
  decryptGitHubSession,
  encryptGitHubSession,
  exchangeGitHubCode,
  getGitHubSession,
  resolveGitHubRedirectUri,
  resetGitHubSessionsForTests,
} from "../src/services/githubOAuthService.js";

const ENV_NAMES = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI",
  "GITHUB_SESSION_ENCRYPTION_KEY",
];

test.beforeEach(() => {
  resetGitHubSessionsForTests();
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  process.env.GITHUB_REDIRECT_URI =
    "https://synchron.foundation/api/github/callback";
  process.env.GITHUB_SESSION_ENCRYPTION_KEY = "session-encryption-key";
});

test.afterEach(() => {
  resetGitHubSessionsForTests();
  for (const name of ENV_NAMES) delete process.env[name];
});

test("builds GitHub OAuth URL with exact callback state", () => {
  const url = new URL(buildGitHubAuthorizationUrl("state-123"));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    process.env.GITHUB_REDIRECT_URI,
  );
  assert.equal(url.searchParams.get("scope"), "public_repo");
  assert.equal(url.searchParams.get("state"), "state-123");
});

test("uses the production callback when no redirect variable is set", () => {
  delete process.env.GITHUB_REDIRECT_URI;
  const url = new URL(buildGitHubAuthorizationUrl("state-123"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://synchron.foundation/api/github/callback",
  );
});

test("falls back to the production callback when the redirect variable is invalid", () => {
  process.env.GITHUB_REDIRECT_URI = process.env.GITHUB_CLIENT_ID;
  assert.equal(
    resolveGitHubRedirectUri(),
    "https://synchron.foundation/api/github/callback",
  );

  const url = new URL(buildGitHubAuthorizationUrl("state-123"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://synchron.foundation/api/github/callback",
  );
});

test("exchanges the authorization code without exposing credentials", async () => {
  let requestBody;
  const tokens = await exchangeGitHubCode("code-123", async (_url, options) => {
    requestBody = String(options.body);
    return new Response(
      JSON.stringify({ access_token: "ghu-user-token", token_type: "bearer" }),
      { status: 200 },
    );
  });
  assert.equal(tokens.access_token, "ghu-user-token");
  assert.match(requestBody, /code=code-123/u);
  assert.match(requestBody, /client_secret=client-secret/u);
});

test("encrypts and restores the GitHub user session", () => {
  const encrypted = encryptGitHubSession({
    accessToken: "ghu-user-token",
    login: "radostinvgeorgiev-commits",
  });
  assert.doesNotMatch(JSON.stringify(encrypted), /ghu-user-token/u);
  assert.deepEqual(decryptGitHubSession(encrypted), {
    accessToken: "ghu-user-token",
    login: "radostinvgeorgiev-commits",
  });
});

test("creates a browser session after checking the GitHub user", async () => {
  const session = await createGitHubSession(
    { access_token: "ghu-user-token" },
    async () =>
      new Response(JSON.stringify({ login: "radostinvgeorgiev-commits" }), {
        status: 200,
      }),
  );
  const stored = await getGitHubSession(session.id);
  assert.equal(session.login, "radostinvgeorgiev-commits");
  assert.equal(stored.accessToken, "ghu-user-token");
});
