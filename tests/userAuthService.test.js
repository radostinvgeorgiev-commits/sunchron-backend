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
  renewalOutcome,
  resolveUserSession,
  signInUser,
  userSessionCookie,
  UserAuthError,
} from "../src/services/userAuthService.js";

const ENV = {
  AUTH_BACKEND: "identity-platform",
  IDENTITY_PLATFORM_PROJECT_ID: "test-identity-project",
  IDENTITY_PLATFORM_API_KEY: "test-identity-platform-api-key-123",
  // Email verification has its own tests in identityPlatformUserAuth.test.js.
  IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION: "false",
  USER_SESSION_ENCRYPTION_KEY:
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

test("requires dedicated user session protection", () => {
  const fallbackEnv = {
    IDENTITY_PLATFORM_PROJECT_ID: ENV.IDENTITY_PLATFORM_PROJECT_ID,
    IDENTITY_PLATFORM_API_KEY: ENV.IDENTITY_PLATFORM_API_KEY,
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
      error instanceof UserAuthError &&
      error.code === "AUTH_SESSION_KEY_MISSING",
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

test("encrypts the user session and never leaves tokens in the cookie", () => {
  const original = session("secret");
  const encrypted = encryptUserSession(original, ENV);
  const cookie = userSessionCookie(original, ENV);

  assert.deepEqual(decryptUserSession(encrypted, ENV), original);
  assert.doesNotMatch(cookie, /access-secret|refresh-secret/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Lax/u);
});

test("signs in with email and password through an isolated auth client", async () => {
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
  assert.equal(result.created, true);
  assert.deepEqual(result.session, fakeSession);
});

test("registration rejects an invalid invite before contacting the auth service", async () => {
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

test("registration approves access after the auth service creates the user", async () => {
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
  assert.equal(result.created, false);
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

test("sign in refuses a valid user without application approval", async () => {
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
  assert.match(identities[0].user.memoryOwnerId, /^identity-platform:/u);
});

test("a renewal failure is ended, temporary or refused by Google's own names", () => {
  assert.equal(renewalOutcome(null), "refused");
  assert.equal(renewalOutcome({ status: 400, upstreamCode: "TOKEN_EXPIRED" }), "ended");
  assert.equal(renewalOutcome({ status: 400, upstreamCode: "INVALID_REFRESH_TOKEN" }), "ended");
  assert.equal(renewalOutcome({ status: 502, upstreamCode: "USER_NOT_FOUND" }), "ended");
  assert.equal(renewalOutcome({ status: 503, code: "IDENTITY_PLATFORM_UNAVAILABLE" }), "temporary");
  assert.equal(renewalOutcome({ status: 429 }), "temporary");
  assert.equal(renewalOutcome({ status: 400, upstreamCode: "TOO_MANY_ATTEMPTS_TRY_LATER" }), "temporary");
  assert.equal(renewalOutcome(new TypeError("fetch failed")), "temporary");
  assert.equal(
    renewalOutcome({
      status: 403,
      upstreamCode: "Requests to this API are blocked.",
      upstreamErrorStatus: "PERMISSION_DENIED",
      upstreamReason: "API_KEY_SERVICE_BLOCKED",
    }),
    "refused",
  );
  assert.equal(renewalOutcome({ status: 400, upstreamCode: "INVALID_ARGUMENT" }), "refused");
});

function expiredSession(suffix) {
  return { ...session(suffix), expires_at: Math.floor(Date.now() / 1000) - 5 };
}

function renewalClient(error) {
  return {
    auth: {
      async getUser() {
        assert.fail("An expired session is renewed, not looked up");
      },
      async refreshSession({ refresh_token }) {
        assert.equal(refresh_token, "refresh-r");
        return { data: null, error };
      },
    },
  };
}

async function renewWithLogs(error) {
  const lines = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => lines.push({ level: "warn", args });
  console.error = (...args) => lines.push({ level: "error", args });
  try {
    const cookie = userSessionCookie(expiredSession("r"), ENV);
    const result = await resolveUserSession(cookie, {
      env: ENV,
      client: renewalClient(error),
      requireTesterAccess: async () => true,
    }).then(
      (value) => ({ value }),
      (thrown) => ({ thrown }),
    );
    return { ...result, lines };
  } finally {
    Object.assign(console, original);
  }
}

test("a passing fault while renewing keeps the sign-in and answers 503", async () => {
  const error = Object.assign(new Error("Identity Platform временно не отговаря."), {
    status: 503,
    code: "IDENTITY_PLATFORM_UNAVAILABLE",
  });
  const { thrown, value, lines } = await renewWithLogs(error);
  assert.equal(value, undefined);
  assert.ok(thrown instanceof UserAuthError);
  assert.equal(thrown.status, 503);
  assert.equal(thrown.code, "AUTH_UNAVAILABLE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].args[0], "[User session] Renewal failed");
  assert.deepEqual(lines[0].args[1], {
    outcome: "temporary",
    name: "Error",
    code: "IDENTITY_PLATFORM_UNAVAILABLE",
    status: 503,
  });
});

test("too many renewals at Google keep the sign-in too", async () => {
  const error = Object.assign(new Error("Identity Platform request failed."), {
    status: 400,
    code: "IDENTITY_PLATFORM_REQUEST_FAILED",
    upstreamCode: "TOO_MANY_ATTEMPTS_TRY_LATER",
  });
  const { thrown } = await renewWithLogs(error);
  assert.equal(thrown?.code, "AUTH_UNAVAILABLE");
});

test("an ended session signs the person out and says why", async () => {
  const error = Object.assign(new Error("Identity Platform request failed."), {
    status: 400,
    code: "IDENTITY_PLATFORM_REQUEST_FAILED",
    upstreamCode: "TOKEN_EXPIRED",
  });
  const { thrown, value, lines } = await renewWithLogs(error);
  assert.equal(thrown, undefined);
  assert.equal(value, null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].args[1].outcome, "ended");
  assert.equal(lines[0].args[1].upstreamCode, "TOKEN_EXPIRED");
});

test("a refused renewal is logged as an error with Google's names only", async () => {
  const error = Object.assign(new Error("Identity Platform request failed."), {
    status: 403,
    code: "IDENTITY_PLATFORM_REQUEST_FAILED",
    upstreamCode:
      "Requests to this API securetoken.googleapis.com method google.identity.securetoken.v1.SecureToken.GrantToken are blocked.",
    upstreamErrorStatus: "PERMISSION_DENIED",
    upstreamReason: "API_KEY_SERVICE_BLOCKED",
  });
  const { value, lines } = await renewWithLogs(error);
  assert.equal(value, null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "error");
  assert.deepEqual(lines[0].args[1], {
    outcome: "refused",
    name: "Error",
    code: "IDENTITY_PLATFORM_REQUEST_FAILED",
    upstreamErrorStatus: "PERMISSION_DENIED",
    status: 403,
    reason: "API_KEY_SERVICE_BLOCKED",
  });
  const logged = JSON.stringify(lines);
  assert.doesNotMatch(logged, /refresh-r|access-r|securetoken|blocked\./u);
});

test("a renewal answer without a session signs the person out", async () => {
  const client = {
    auth: {
      async getUser() {
        assert.fail("An expired session is renewed, not looked up");
      },
      async refreshSession() {
        return { data: { session: null, user: null }, error: null };
      },
    },
  };
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    const value = await resolveUserSession(userSessionCookie(expiredSession("r"), ENV), {
      env: ENV,
      client,
      requireTesterAccess: async () => true,
    });
    assert.equal(value, null);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0][1].outcome, "refused");
});
