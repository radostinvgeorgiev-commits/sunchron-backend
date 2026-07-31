import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptUserSession,
  encryptUserSession,
  getTesterInviteCode,
  getUserAuthConfigurationStatus,
  isTesterRegistrationEnabled,
  isUserAuthConfigured,
  registerTester,
  resolveUserSession,
  signInUser,
  userSessionCookie,
  UserAuthError,
} from "../src/services/userAuthService.js";

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SESSION_ENCRYPTION_KEY:
    "test-session-encryption-key-with-enough-entropy",
  SYNCHRON_TEST_INVITE_CODE: "KAMCHIA-TEST-2026",
  MEMORY_OWNER_ID: "primary-user",
};

function session(suffix = "a") {
  return {
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  };
}

test("detects complete auth and closed/open tester registration", () => {
  assert.equal(isUserAuthConfigured(ENV), true);
  assert.equal(isTesterRegistrationEnabled(ENV), true);
  assert.equal(
    isTesterRegistrationEnabled({
      ...ENV,
      SYNCHRON_TEST_INVITE_CODE: "",
    }),
    false,
  );
});

test("derives isolated tester secrets from the existing owner session secret", () => {
  const fallbackEnv = {
    SUPABASE_URL: ENV.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY,
    GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
  };
  const expectedSession = session("derived");
  assert.equal(isUserAuthConfigured(fallbackEnv), true);
  assert.equal(isTesterRegistrationEnabled(fallbackEnv), true);
  assert.equal(getTesterInviteCode(fallbackEnv).length, 16);
  assert.notEqual(
    getTesterInviteCode(fallbackEnv),
    fallbackEnv.GITHUB_SESSION_ENCRYPTION_KEY,
  );
  assert.deepEqual(
    decryptUserSession(
      encryptUserSession(expectedSession, fallbackEnv),
      fallbackEnv,
    ),
    expectedSession,
  );
});

test("dedicated tester secrets override the owner-session fallback", () => {
  assert.equal(getTesterInviteCode(ENV), ENV.SYNCHRON_TEST_INVITE_CODE);
  assert.equal(isUserAuthConfigured(ENV), true);
});

test("the configured GitHub client secret is a safe final fallback", () => {
  const fallbackEnv = {
    SUPABASE_URL: ENV.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY,
    GITHUB_CLIENT_SECRET: "github-client-secret-with-enough-entropy",
  };
  assert.equal(isUserAuthConfigured(fallbackEnv), true);
  assert.equal(isTesterRegistrationEnabled(fallbackEnv), true);
  assert.equal(getTesterInviteCode(fallbackEnv).length, 16);
});

test("uses the public production Supabase connection when App Platform omits it", () => {
  const fallbackEnv = {
    GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
  };
  assert.equal(isUserAuthConfigured(fallbackEnv), true);
  assert.equal(isTesterRegistrationEnabled(fallbackEnv), true);
});

test("derives session protection from the private production invite code", () => {
  const productionLikeEnv = {
    SYNCHRON_TEST_INVITE_CODE: "private-invite-code-with-enough-entropy",
  };
  assert.equal(isUserAuthConfigured(productionLikeEnv), true);
  assert.equal(isTesterRegistrationEnabled(productionLikeEnv), true);
});

test("uses the operational MCP secret when the invite code is short", () => {
  const productionLikeEnv = {
    MCP_ACCESS_TOKEN: "mcp-access-token-with-at-least-32-characters",
    SYNCHRON_TEST_INVITE_CODE: "short-code",
  };
  assert.equal(isUserAuthConfigured(productionLikeEnv), true);
  assert.equal(isTesterRegistrationEnabled(productionLikeEnv), true);
  assert.deepEqual(getUserAuthConfigurationStatus(productionLikeEnv), {
    projectConnection: true,
    sessionProtection: true,
  });
});

test("rejects encrypted App Platform placeholders before using public bootstrap", () => {
  const productionLikeEnv = {
    SUPABASE_URL: "EV[1:encrypted-placeholder]",
    SUPABASE_PUBLISHABLE_KEY: "EV[1:encrypted-placeholder]",
    MCP_ACCESS_TOKEN: "mcp-access-token-with-at-least-32-characters",
    SYNCHRON_TEST_INVITE_CODE: "short-code",
  };
  assert.deepEqual(getUserAuthConfigurationStatus(productionLikeEnv), {
    projectConnection: true,
    sessionProtection: true,
  });
  assert.equal(isUserAuthConfigured(productionLikeEnv), true);
});

test("encrypts the Supabase session and never leaves tokens in the cookie", () => {
  const original = session("secret");
  const encrypted = encryptUserSession(original, ENV);
  const cookie = userSessionCookie(original, ENV);

  assert.deepEqual(decryptUserSession(encrypted, ENV), original);
  assert.doesNotMatch(cookie, /access-secret|refresh-secret/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Lax/u);
});

test("signs in with email and password through an isolated Supabase client", async () => {
  const fakeSession = session("login");
  const client = {
    auth: {
      async signInWithPassword(credentials) {
        assert.deepEqual(credentials, {
          email: "friend@example.com",
          password: "strong-pass-123",
        });
        return {
          data: {
            user: { id: "user-login", email: credentials.email },
            session: fakeSession,
          },
          error: null,
        };
      },
    },
  };

  const result = await signInUser(
    { email: " Friend@Example.com ", password: "strong-pass-123" },
    { env: ENV, client, requireTesterAccess: async () => true },
  );
  assert.equal(result.user.id, "user-login");
  assert.deepEqual(result.session, fakeSession);
});

test("uses the Supabase Auth password endpoint without exposing a service key", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options) => {
    assert.equal(
      url,
      "https://project.supabase.co/auth/v1/token?grant_type=password",
    );
    assert.equal(options.method, "POST");
    assert.equal(options.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(
      options.headers.Authorization,
      `Bearer ${ENV.SUPABASE_PUBLISHABLE_KEY}`,
    );
    assert.deepEqual(JSON.parse(options.body), {
      email: "friend@example.com",
      password: "strong-pass-123",
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          user: { id: "rest-user", email: "friend@example.com" },
          access_token: "rest-access",
          refresh_token: "rest-refresh",
          expires_in: 3600,
          token_type: "bearer",
        };
      },
    };
  };

  const result = await signInUser(
    { email: "friend@example.com", password: "strong-pass-123" },
    { env: ENV, requireTesterAccess: async () => true },
  );

  assert.equal(result.user.id, "rest-user");
  assert.equal(result.session.access_token, "rest-access");
  assert.ok(result.session.expires_at > Math.floor(Date.now() / 1000));
});

test("tester registration requires the private invite code", async () => {
  await assert.rejects(
    registerTester(
      {
        email: "friend@example.com",
        password: "strong-pass-123",
        displayName: "Приятел",
        inviteCode: "wrong-code",
      },
      { env: ENV, client: { auth: {} } },
    ),
    (error) =>
      error instanceof UserAuthError &&
      error.code === "AUTH_INVALID_INVITE_CODE" &&
      error.status === 403,
  );
});

test("successful tester registration creates the application approval", async () => {
  const fakeSession = session("register");
  let approvedUser = null;
  const client = {
    auth: {
      async signUp({ email, password, options }) {
        assert.equal(email, "friend@example.com");
        assert.equal(password, "strong-pass-123");
        assert.equal(options.data.display_name, "Приятел");
        return {
          data: {
            user: { id: "registered-user", email },
            session: fakeSession,
          },
          error: null,
        };
      },
    },
  };

  const result = await registerTester(
    {
      email: "friend@example.com",
      password: "strong-pass-123",
      displayName: "Приятел",
      inviteCode: ENV.SYNCHRON_TEST_INVITE_CODE,
    },
    {
      env: ENV,
      client,
      approveAccess: async (user) => {
        approvedUser = user;
      },
    },
  );

  assert.equal(approvedUser.id, "registered-user");
  assert.equal(result.user.id, "registered-user");
  assert.deepEqual(result.session, fakeSession);
});

test("sign in refuses a valid Supabase user without application approval", async () => {
  const client = {
    auth: {
      async signInWithPassword({ email }) {
        return {
          data: {
            user: { id: "direct-signup", email },
            session: session("direct"),
          },
          error: null,
        };
      },
    },
  };

  await assert.rejects(
    signInUser(
      { email: "direct@example.com", password: "strong-pass-123" },
      {
        env: ENV,
        client,
        requireTesterAccess: async () => {
          const error = new Error("not approved");
          error.code = "TESTER_ACCESS_NOT_APPROVED";
          error.status = 403;
          throw error;
        },
      },
    ),
    (error) =>
      error instanceof UserAuthError &&
      error.code === "TESTER_ACCESS_NOT_APPROVED" &&
      error.status === 403,
  );
});

test("two authenticated users receive different stable memory owners", async () => {
  const identities = [];
  for (const suffix of ["a", "b"]) {
    const stored = session(suffix);
    const cookie = userSessionCookie(stored, ENV);
    const client = {
      auth: {
        async getUser(accessToken) {
          assert.equal(accessToken, stored.access_token);
          return {
            data: {
              user: {
                id: `00000000-0000-4000-8000-00000000000${suffix}`,
                email: `${suffix}@example.com`,
                user_metadata: { display_name: `Тестер ${suffix}` },
              },
            },
            error: null,
          };
        },
        async refreshSession() {
          assert.fail("A non-expired session must not be refreshed");
        },
      },
    };
    identities.push(
      await resolveUserSession(cookie, {
        env: ENV,
        client,
        requireTesterAccess: async () => true,
      }),
    );
  }

  assert.equal(identities[0].user.role, "tester");
  assert.notEqual(
    identities[0].user.memoryOwnerId,
    identities[1].user.memoryOwnerId,
  );
  assert.match(identities[0].user.memoryOwnerId, /^supabase:/u);
});
