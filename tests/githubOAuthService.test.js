import assert from "node:assert/strict";
import test from "node:test";
import { configureGitHubAppFixture, githubAppFetchFixture } from "./githubAppFixture.js";

import {
  buildGitHubAuthorizationUrl,
  createGitHubSession,
  decryptGitHubSession,
  encryptGitHubSession,
  exchangeGitHubCode,
  getGitHubSession,
  getLatestAuthorizedGitHubSession,
  isActiveAuthorizedGitHubSession,
  isAuthorizedGitHubLogin,
  resolveGitHubRedirectUri,
  resolveOwnerGitHubLogin,
  resetGitHubSessionsForTests,
} from "../src/services/githubOAuthService.js";

const ENV_NAMES = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI",
  "GITHUB_SESSION_ENCRYPTION_KEY",
  "GITHUB_REPOSITORY",
  "SYNCHRON_OWNER_GITHUB_LOGIN",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
];

test.beforeEach(() => {
  resetGitHubSessionsForTests();
  configureGitHubAppFixture();
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  process.env.GITHUB_REDIRECT_URI =
    "https://cloudaicore.com/api/github/callback";
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
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.get("state"), "state-123");
});

test("uses the production callback when no redirect variable is set", () => {
  delete process.env.GITHUB_REDIRECT_URI;
  const url = new URL(buildGitHubAuthorizationUrl("state-123"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://cloudaicore.com/api/github/callback",
  );
});

test("falls back to the production callback when the redirect variable is invalid", () => {
  process.env.GITHUB_REDIRECT_URI = process.env.GITHUB_CLIENT_ID;
  assert.equal(
    resolveGitHubRedirectUri(),
    "https://cloudaicore.com/api/github/callback",
  );

  const url = new URL(buildGitHubAuthorizationUrl("state-123"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://cloudaicore.com/api/github/callback",
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
    githubAppFetchFixture({ token: "scoped-token" }),
  );
  const stored = await getGitHubSession(session.id);
  assert.equal(session.login, "radostinvgeorgiev-commits");
  assert.equal(stored.accessToken, "scoped-token");
  assert.equal(stored.repository, "radostinvgeorgiev-commits/sunchron-backend");
});

test("rejects non-owner and old broad OAuth sessions", async () => {
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  await assert.rejects(
    () => createGitHubSession({ access_token: "foreign-token" }, githubAppFetchFixture({ login: "another-user" })),
    (error) => error.code === "OWNER_GITHUB_LOGIN_REQUIRED",
  );
  assert.equal(
    isActiveAuthorizedGitHubSession({
      accessToken: "valid-token",
      login: "radostinvgeorgiev-commits",
    }),
    false,
  );
  assert.equal(await getLatestAuthorizedGitHubSession(), null);
});

test("rejects installation tokens not restricted to the configured repository", async () => {
  await assert.rejects(
    () => createGitHubSession({ access_token: "test-user" }, githubAppFetchFixture({
      repositories: [{ full_name: "other/repository" }],
    })),
    (error) => error.code === "GITHUB_APP_REPOSITORY_MISMATCH",
  );
});

test("requests one repository and rejects broad scopes, multiple repositories and invalid expiry", async () => {
  const fixture = githubAppFetchFixture();
  await createGitHubSession({ access_token: "test-user" }, async (url, options) => {
    if (String(url).endsWith("/access_tokens")) {
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ["sunchron-backend"],
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          actions: "read",
          checks: "read",
        },
      });
    }
    return fixture(url, options);
  });
  await assert.rejects(
    () => createGitHubSession({ access_token: "test-user", scope: "public_repo" }, fixture),
    (error) => error.code === "GITHUB_APP_SCOPE_INVALID",
  );
  await assert.rejects(
    () => createGitHubSession({ access_token: "test-user" }, githubAppFetchFixture({
      repositories: [
        { full_name: "radostinvgeorgiev-commits/sunchron-backend" },
        { full_name: "other/repository" },
      ],
    })),
    (error) => error.code === "GITHUB_APP_REPOSITORY_MISMATCH",
  );
  const session = {
    accessToken: "test-token",
    login: "radostinvgeorgiev-commits",
    credentialType: "github-app-installation",
    repository: "radostinvgeorgiev-commits/sunchron-backend",
  };
  assert.equal(isActiveAuthorizedGitHubSession(session), false);
  assert.equal(isActiveAuthorizedGitHubSession({ ...session, expiresAt: Date.now() - 1 }), false);
  assert.equal(isActiveAuthorizedGitHubSession({ ...session, expiresAt: Infinity }), false);
});

test("requires GitHub App configuration before requesting authorization", () => {
  delete process.env.GITHUB_APP_ID;
  assert.throws(() => buildGitHubAuthorizationUrl("state"), (error) => error.code === "GITHUB_OAUTH_NOT_CONFIGURED");
});
test("derives the only allowed owner from the configured repository", () => {
  process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
  assert.equal(resolveOwnerGitHubLogin(), "radostinvgeorgiev-commits");
  assert.equal(isAuthorizedGitHubLogin("radostinvgeorgiev-commits"), true);
  assert.equal(isAuthorizedGitHubLogin("another-user"), false);
});

test("supports an explicit owner login without widening access", () => {
  process.env.SYNCHRON_OWNER_GITHUB_LOGIN = "Radko-Owner";
  assert.equal(resolveOwnerGitHubLogin(), "Radko-Owner");
  assert.equal(isAuthorizedGitHubLogin("radko-owner"), true);
  assert.equal(isAuthorizedGitHubLogin("radostinvgeorgiev-commits"), false);
});
