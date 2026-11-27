import assert from "node:assert/strict";
import test from "node:test";
import {
  finishGitHubSignIn,
  isGitHubSignInCallback,
  isGitHubSignInEnabled,
  startGitHubSignIn,
} from "../src/services/githubSignInService.js";
import { createGitHubCallbackHandler } from "../src/routes/githubOAuthRouter.js";
import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../src/services/googleCloudActionService.js";

const env = {
  GITHUB_SIGN_IN: "on",
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-secret-value",
  USER_REGISTRATION_MODE: "public",
};
const cookieHeader = "x=1; synchron_github_signin_state=s1";

test("GitHub sign-in is on by default, can be switched off, and needs the GitHub app", () => {
  assert.equal(isGitHubSignInEnabled({ ...env, GITHUB_SIGN_IN: "" }), true);
  assert.equal(isGitHubSignInEnabled({ ...env, GITHUB_SIGN_IN: "off" }), false);
  assert.equal(isGitHubSignInEnabled({ ...env, GITHUB_CLIENT_SECRET: "" }), false);
  assert.equal(isGitHubSignInEnabled({ ...env, USER_REGISTRATION_MODE: "invite" }), false);
  assert.equal(isGitHubSignInEnabled(env), true);
});

test("start goes to GitHub with the registered callback and a state cookie", () => {
  const { url, cookie } = startGitHubSignIn({ env });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://github.com");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://cloudaicore.com/api/github/callback");
  assert.equal(parsed.searchParams.get("scope"), "read:user user:email");
  const state = parsed.searchParams.get("state");
  assert.match(cookie, new RegExp(`synchron_github_signin_state=${state}; Path=/api;`));
  assert.equal(isGitHubSignInCallback({ state, cookieHeader: `synchron_github_signin_state=${state}` }), true);
  assert.equal(isGitHubSignInCallback({ state, cookieHeader: `synchron_github_state=${state}` }), false);
});

function deps(idp) {
  const calls = {};
  return {
    calls,
    options: {
      env,
      exchangeCode: async (code) => ((calls.code = code), { access_token: "gh-token" }),
      client: {
        auth: {
          async signInWithGitHubAccessToken(args) {
            calls.idp = args;
            return idp || {
              data: {
                user: { id: "u1", email: "a@b.c" },
                session: { access_token: "t", refresh_token: "r", expires_at: 9e9 },
                isNewUser: true,
              },
              error: null,
            };
          },
        },
      },
      approveAccess: async (_user, opts) => {
        calls.approved = opts;
      },
    },
  };
}

test("a matching callback signs in through Identity Platform and approves access", async () => {
  const { calls, options } = deps();
  const result = await finishGitHubSignIn({ code: "c", state: "s1", cookieHeader }, options);
  assert.equal(calls.idp.accessToken, "gh-token");
  assert.equal(calls.approved.createOnly, true);
  assert.equal(result.created, true);
});

test("a forged state is refused before the code is exchanged", async () => {
  const { calls, options } = deps();
  await assert.rejects(
    finishGitHubSignIn({ code: "c", state: "other", cookieHeader }, options),
    { code: "AUTH_GITHUB_STATE_INVALID" },
  );
  assert.equal(calls.code, undefined);
});

test("an email that already has a profile is told how to sign in, not merged", async () => {
  const { options } = deps({ data: null, error: { upstreamCode: "NEED_CONFIRMATION" } });
  await assert.rejects(
    finishGitHubSignIn({ code: "c", state: "s1", cookieHeader }, options),
    { code: "AUTH_GITHUB_EXISTING_ACCOUNT" },
  );
  const disabled = deps({ data: null, error: { upstreamCode: "OPERATION_NOT_ALLOWED" } });
  await assert.rejects(
    finishGitHubSignIn({ code: "c", state: "s1", cookieHeader }, disabled.options),
    { code: "AUTH_GITHUB_PROVIDER_DISABLED" },
  );
});

test("the shared callback leaves the owner's GitHub connection alone", async () => {
  let finished = false;
  let passed = false;
  const handler = createGitHubCallbackHandler({
    finishSignIn: async () => ((finished = true), { session: {}, created: false }),
    logError: () => {},
  });
  await handler(
    { query: { code: "c", state: "owner-state" }, headers: { cookie: "synchron_github_state=owner-state" } },
    {},
    () => {
      passed = true;
    },
  );
  assert.equal(passed, true);
  assert.equal(finished, false);
});

test("enable_github_sign_in turns on github.com without exposing the secret", async () => {
  const cloudEnv = {
    GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
    K_SERVICE: "synchron-backend-google",
    ...env,
  };
  let stored;
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_github_sign_in", input: {}, env: cloudEnv },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  assert.equal(stored.action, "infrastructure.write:enable_github_sign_in");
  assert.equal(prepared.resource.provider, "github.com");
  assert.doesNotMatch(JSON.stringify([stored, prepared]), /gh-secret-value/u);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      return { ok: true, json: async () => ({ access_token: "token" }) };
    }
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const missing = (options.method || "GET") === "GET";
    return { ok: !missing, status: missing ? 404 : 200, text: async () => (missing ? "{}" : "{}") };
  };
  const saved = { ...process.env };
  Object.assign(process.env, cloudEnv);
  try {
    const result = await confirmGoogleCloudAction(
      { ownerId: "owner", sessionId: "s", confirmationId: "c1" },
      {
        validateConfirmation: async () => stored,
        consumeConfirmation: async () => {},
        executeWrite: async ({ execute }) => execute(),
        adapters: { fetchImpl },
      },
    );
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "POST"]);
    assert.match(calls[1].url, /defaultSupportedIdpConfigs\?idpId=github\.com$/u);
    assert.equal(JSON.parse(calls[1].body).clientId, "gh-client");
    assert.deepEqual(result, {
      projectId: "handy-boulevard-479120-q9",
      provider: "github.com",
      enabled: true,
      created: true,
    });
  } finally {
    for (const key of Object.keys(cloudEnv)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
