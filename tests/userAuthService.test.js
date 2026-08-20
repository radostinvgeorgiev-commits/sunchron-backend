import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptUserSession,
  encryptUserSession,
  getTesterInviteCode,
  getUserAuthConfigurationStatus,
  isTesterRegistrationEnabled,
  isUserRegistrationEnabled,
  isUserAuthConfigured,
  registerUser,
  resolveUserSession,
  signInUser,
  userSessionCookie,
  UserAuthError,
} from "../src/services/userAuthService.js";
import {
  resolveTesterAuthConnection,
  TESTER_AUTH_BOOTSTRAP,
} from "../src/config/testerAuthBootstrap.js";

const ENV = {
  AUTH_BACKEND: "supabase",
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
  assert.equal(isUserRegistrationEnabled(ENV), true);
  assert.equal(isTesterRegistrationEnabled(ENV), true);
  assert.equal(
    isTesterRegistrationEnabled({
      ...ENV,
      SYNCHRON_TEST_INVITE_CODE: "",
    }),
    false,
  );
  assert.equal(
    isUserRegistrationEnabled({
      ...ENV,
      SYNCHRON_TEST_INVITE_CODE: "",
    }),
    false,
  );
});

test("auth resolves the Supabase URL and key as one atomic connection", () => {
  for (const partialRuntime of [
    {
      SUPABASE_URL: "not-a-url",
      SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY,
    },
    {
      SUPABASE_URL: ENV.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: "not-a-publishable-key",
    },
  ]) {
    const connection = resolveTesterAuthConnection(partialRuntime);
    assert.deepEqual(connection, {
      ...TESTER_AUTH_BOOTSTRAP,
      connectionSource: "public-bootstrap",
    });
    assert.equal(
      getUserAuthConfigurationStatus({
        AUTH_BACKEND: "supabase",
        ...partialRuntime,
        SUPABASE_SESSION_ENCRYPTION_KEY:
          ENV.SUPABASE_SESSION_ENCRYPTION_KEY,
      }).projectConnection,
      true,
    );
  }

  assert.equal(resolveTesterAuthConnection(ENV).connectionSource, "runtime");
});

test("requires dedicated Supabase session protection", () => {
  const fallbackEnv = {
    AUTH_BACKEND: "supabase",
    SUPABASE_URL: ENV.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY,
    GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
    GITHUB_CLIENT_SECRET: "github-client-secret-with-enough-entropy",
    MCP_ACCESS_TOKEN: "mcp-access-token-with-at-least-32-characters",
    SYNCHRON_TEST_INVITE_CODE: "private-invite-code-with-enough-entropy",
  };

  assert.equal(isUserAuthConfigured(fallbackEnv), false);
  assert.deepEqual(getUserAuthConfigurationStatus(fallbackEnv), {
    projectConnection: true,
    sessionProtection: false,
  });
  assert.throws(
    () => encryptUserSession(session("missing-dedicated-key"), fallbackEnv),
    (error) =>
      error instanceof UserAuthError && error.code === "AUTH_SESSION_KEY_MISSING",
  );
});

test("uses only the explicitly configured tester invite code", () => {
  assert.equal(getTesterInviteCode(ENV), ENV.SYNCHRON_TEST_INVITE_CODE);
  assert.equal(isUserAuthConfigured(ENV), true);
  assert.equal(
    getTesterInviteCode({
      GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
      GITHUB_CLIENT_SECRET: "github-client-secret-with-enough-entropy",
    }),
    "",
  );
  assert.equal(
    isTesterRegistrationEnabled({
      GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
    }),
    false,
  );
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

test("normal registration creates the application approval", async () => {
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

  const result = await registerUser(
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

test("registration rejects an invalid invite before contacting Supabase", async () => {
  let signUpCalls = 0;
  const client = {
    auth: {
      async signUp() {
        signUpCalls += 1;
        return { data: null, error: null };
      },
    },
  };

  await assert.rejects(
    registerUser(
      {
        email: "unknown@example.com",
        password: "strong-pass-123",
        displayName: "Непознат",
        inviteCode: "wrong-invite-code",
      },
      { env: ENV, client },
    ),
    (error) =>
      error instanceof UserAuthError &&
      error.code === "AUTH_INVITE_INVALID" &&
      error.status === 403,
  );
  assert.equal(signUpCalls, 0);
});

test("registration approves access after Supabase creates the user", async () => {
  const calls = [];
  const client = {
    auth: {
      async signUp({ email }) {
        calls.push(`signup:${email}`);
        return {
          data: {
            user: { id: "preapproved-user", email },
            session: session("preapproved"),
          },
          error: null,
        };
      },
    },
  };

  await registerUser(
    {
      email: "friend@example.com",
      password: "strong-pass-123",
      displayName: "Приятел",
      inviteCode: ENV.SYNCHRON_TEST_INVITE_CODE,
    },
    {
      env: ENV,
      client,
      approveAccess: async (user) => calls.push(`approve-user:${user.id}`),
    },
  );

  assert.deepEqual(calls, [
    "signup:friend@example.com",
    "approve-user:preapproved-user",
  ]);
});

test("registration recovers an existing invited user with the same password", async () => {
  const fakeSession = session("recovered");
  let approvedUser = null;
  const client = {
    auth: {
      async signUp() {
        return { data: null, error: { status: 422 } };
      },
      async signInWithPassword(credentials) {
        assert.deepEqual(credentials, {
          email: "friend@example.com",
          password: "strong-pass-123",
        });
        return {
          data: {
            user: { id: "existing-user", email: credentials.email },
            session: fakeSession,
          },
          error: null,
        };
      },
    },
  };

  const result = await registerUser(
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

  assert.equal(approvedUser.id, "existing-user");
  assert.equal(result.user.id, "existing-user");
  assert.deepEqual(result.session, fakeSession);
  assert.equal(result.confirmationRequired, false);
});

test("registration recovers an existing invited user from an obfuscated signup response", async () => {
  const fakeSession = session("recovered-obfuscated");
  let approvedUser = null;
  const client = {
    auth: {
      async signUp({ email }) {
        return {
          data: {
            user: { id: "obfuscated-user", email, identities: [] },
            session: null,
          },
          error: null,
        };
      },
      async signInWithPassword(credentials) {
        assert.deepEqual(credentials, {
          email: "friend@example.com",
          password: "strong-pass-123",
        });
        return {
          data: {
            user: { id: "existing-user", email: credentials.email },
            session: fakeSession,
          },
          error: null,
        };
      },
    },
  };

  const result = await registerUser(
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

  assert.equal(approvedUser.id, "existing-user");
  assert.equal(result.user.id, "existing-user");
  assert.deepEqual(result.session, fakeSession);
  assert.equal(result.confirmationRequired, false);
});

test("registration never approves an obfuscated existing user when recovery fails", async () => {
  let approvedUser = null;
  const client = {
    auth: {
      async signUp({ email }) {
        return {
          data: {
            user: { id: "obfuscated-user", email, identities: [] },
            session: null,
          },
          error: null,
        };
      },
      async signInWithPassword() {
        return {
          data: { user: null, session: null },
          error: { status: 400, message: "Invalid credentials" },
        };
      },
    },
  };

  await assert.rejects(
    registerUser(
      {
        email: "friend@example.com",
        password: "wrong-pass-123",
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
    ),
    (error) =>
      error instanceof UserAuthError &&
      error.code === "AUTH_SIGNUP_REJECTED" &&
      error.status === 422,
  );
  assert.equal(approvedUser, null);
});

test("registration keeps a new unconfirmed user when immediate sign in is unavailable", async () => {
  let approvedUser = null;
  const client = {
    auth: {
      async signUp({ email }) {
        return {
          data: {
            user: { id: "new-unconfirmed-user", email },
            session: null,
          },
          error: null,
        };
      },
      async signInWithPassword() {
        return {
          data: { user: null, session: null },
          error: { status: 400, message: "Email not confirmed" },
        };
      },
    },
  };

  const result = await registerUser(
    {
      email: "new@example.com",
      password: "strong-pass-123",
      displayName: "Нов тестер",
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

  assert.equal(approvedUser.id, "new-unconfirmed-user");
  assert.equal(result.user.id, "new-unconfirmed-user");
  assert.equal(result.session, null);
  assert.equal(result.confirmationRequired, true);
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

  assert.equal(identities[0].user.role, "member");
  assert.notEqual(
    identities[0].user.memoryOwnerId,
    identities[1].user.memoryOwnerId,
  );
  assert.match(identities[0].user.memoryOwnerId, /^supabase:/u);
});
