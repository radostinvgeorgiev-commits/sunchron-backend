import assert from "node:assert/strict";
import test from "node:test";

import {
  getUserAuthConfigurationStatus,
  getUserAuthProvider,
  isUserAuthConfigured,
  resolveUserSession,
  userSessionCookie,
} from "../src/services/userAuthService.js";
import {
  approveTesterAccess,
  assertTesterAccess,
  setFirestoreTesterAccessStoreForTests,
} from "../src/services/testerAccessService.js";

const ENV = Object.freeze({
  AUTH_BACKEND: "identity-platform",
  IDENTITY_PLATFORM_PROJECT_ID: "handy-boulevard-479120-q9",
  IDENTITY_PLATFORM_API_KEY: "identity-api-key-1234567890",
  IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION: "true",
  USER_SESSION_ENCRYPTION_KEY:
    "identity-session-encryption-key-with-enough-entropy",
  SYNCHRON_TEST_INVITE_CODE: "identity-pilot-invite",
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
});

function session() {
  return {
    access_token: "identity-access",
    refresh_token: "identity-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "Bearer",
  };
}

function accessStore() {
  const records = new Map();
  return {
    records,
    async set(id, data) {
      records.set(id, structuredClone(data));
    },
    async get(id) {
      const data = records.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
  };
}

test.afterEach(() => setFirestoreTesterAccessStoreForTests(null));

test("Identity Platform configuration is complete only with its dedicated session key", () => {
  assert.equal(getUserAuthProvider(ENV), "identity-platform");
  assert.equal(isUserAuthConfigured(ENV), true);
  assert.deepEqual(getUserAuthConfigurationStatus(ENV), {
    projectConnection: true,
    sessionProtection: true,
  });
  assert.equal(
    isUserAuthConfigured({
      ...ENV,
      USER_SESSION_ENCRYPTION_KEY: "",
      SUPABASE_SESSION_ENCRYPTION_KEY: "legacy-key-must-not-be-used",
    }),
    false,
  );
});

test("Identity Platform sessions receive an isolated provider namespace", async () => {
  const storedSession = session();
  const cookie = userSessionCookie(storedSession, ENV);
  const identity = await resolveUserSession(cookie, {
    env: ENV,
    requireTesterAccess: async () => true,
    client: {
      auth: {
        async getUser(accessToken) {
          assert.equal(accessToken, storedSession.access_token);
          return {
            data: {
              user: {
                id: "identity-user-a",
                email: "friend@example.com",
                displayName: "Приятел",
                emailVerified: true,
                authProvider: "identity-platform",
              },
            },
            error: null,
          };
        },
      },
    },
  });

  assert.equal(identity.user.authProvider, "identity-platform");
  assert.equal(identity.user.displayName, "Приятел");
  assert.equal(
    identity.user.memoryOwnerId,
    "identity-platform:identity-user-a",
  );
});

test("Identity Platform refuses an unverified email even with a valid password", async () => {
  const { signInUser, UserAuthError } =
    await import("../src/services/userAuthService.js");
  await assert.rejects(
    signInUser(
      { email: "friend@example.com", password: "strong-pass-123" },
      {
        env: ENV,
        requireTesterAccess: async () => assert.fail("must verify first"),
        client: {
          auth: {
            async signInWithPassword() {
              return {
                data: {
                  user: {
                    id: "identity-user-a",
                    email: "friend@example.com",
                    emailVerified: false,
                    authProvider: "identity-platform",
                  },
                  session: session(),
                },
                error: null,
              };
            },
          },
        },
      },
    ),
    (error) =>
      error instanceof UserAuthError &&
      error.code === "AUTH_EMAIL_NOT_VERIFIED" &&
      error.status === 403,
  );
});

test("Identity Platform registration approves the invited profile but withholds the session until verification", async () => {
  const { registerUser } = await import("../src/services/userAuthService.js");
  let approvedUser = null;
  const result = await registerUser(
    {
      email: "new@example.com",
      password: "strong-pass-123",
      displayName: "Нов тестер",
      inviteCode: ENV.SYNCHRON_TEST_INVITE_CODE,
    },
    {
      env: ENV,
      client: {
        auth: {
          async signUp() {
            return {
              data: {
                user: {
                  id: "identity-user-new",
                  email: "new@example.com",
                  emailVerified: false,
                  authProvider: "identity-platform",
                },
                session: null,
                confirmationRequired: true,
              },
              error: null,
            };
          },
        },
      },
      approveAccess: async (user) => {
        approvedUser = user;
      },
    },
  );

  assert.equal(result.confirmationRequired, true);
  assert.equal(result.session, null);
  assert.equal(approvedUser.id, "identity-user-new");
  assert.equal(approvedUser.authProvider, "identity-platform");
});

test("Identity Platform tester approvals persist in Firestore without OpenSearch", async () => {
  const store = accessStore();
  setFirestoreTesterAccessStoreForTests(store);
  const user = {
    id: "identity-user-a",
    email: "friend@example.com",
    authProvider: "identity-platform",
  };

  await approveTesterAccess(user, { env: ENV });
  assert.ok(store.records.has("identity-platform:identity-user-a"));
  assert.equal(await assertTesterAccess(user, { env: ENV }), true);
  assert.equal(
    store.records.values().next().value.authProvider,
    "identity-platform",
  );
});
