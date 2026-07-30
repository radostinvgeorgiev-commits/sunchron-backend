import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptUserSession,
  encryptUserSession,
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

test("Supabase sessions require their own encryption key", () => {
  assert.equal(
    isUserAuthConfigured({
      SUPABASE_URL: ENV.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY,
      GITHUB_SESSION_ENCRYPTION_KEY: "github-only-key-with-enough-entropy",
      GOOGLE_SESSION_ENCRYPTION_KEY: "google-only-key-with-enough-entropy",
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
    { env: ENV, client },
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
    { env: ENV },
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
