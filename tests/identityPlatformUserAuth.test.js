import assert from "node:assert/strict";
import test from "node:test";

import { createIdentityPlatformAuthClient } from "../src/services/identityPlatformAuthClient.js";
import {
  getUserAuthConfigurationStatus,
  getUserAuthProvider,
  isUserAuthConfigured,
  registerUser,
  resolveUserSession,
  signInUser,
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

test("public sign-in resends verification only after accepting credentials for an unverified account", async () => {
  const { signInUser } = await import("../src/services/userAuthService.js");
  const pendingSession = session();
  const credentials = { email: "friend@example.com", password: "strong-pass-123" };
  const env = { ...ENV, USER_REGISTRATION_MODE: "public" };
  for (const accepted of [true, false]) {
    const verificationRequests = [];
    await assert.rejects(
      signInUser(credentials, {
        env,
        requireTesterAccess: async () => assert.fail("must verify first"),
        client: {
          auth: {
            async signInWithPassword() {
              return accepted
                ? { data: { user: { emailVerified: false }, session: pendingSession } }
                : { error: { status: 400 } };
            },
            async sendVerificationEmail(accessToken) {
              verificationRequests.push(accessToken);
              return { data: { sent: true }, error: null };
            },
          },
        },
      }),
      { code: accepted ? "AUTH_EMAIL_VERIFICATION_RESENT" : "AUTH_INVALID_CREDENTIALS" },
    );
    assert.deepEqual(verificationRequests, accepted ? [pendingSession.access_token] : []);
  }
});

test("public registration can be completed after the email or access write fails", async () => {
  const env = { ...ENV, USER_REGISTRATION_MODE: "public" };
  const credentials = {
    email: "retry@example.test",
    password: "local-test-password",
  };
  const user = { localId: "recoverable-user", email: credentials.email };
  const providerSession = {
    ...user,
    idToken: "local-id-token",
    refreshToken: "local-refresh-token",
  };
  const accessId = `identity-platform:${user.localId}`;
  const upstreamError = (message, status = 400) =>
    Response.json({ error: { message } }, { status });

  for (const failure of ["email", "access"]) {
    const store = accessStore();
    let accountExists = false;
    let verified = false;
    let emailSent = false;
    let failed = false;
    setFirestoreTesterAccessStoreForTests({
      ...store,
      async set(id, data, options) {
        assert.equal(options.createOnly, true);
        if (failure === "access" && !failed) {
          failed = true;
          throw new Error("Temporary access store failure");
        }
        if (store.records.has(id)) {
          const error = new Error("Document exists");
          error.upstreamErrorStatus = "ALREADY_EXISTS";
          throw error;
        }
        return store.set(id, data);
      },
    });
    const client = createIdentityPlatformAuthClient({
      env,
      async fetchImpl(url, { body }) {
        switch (new URL(url).pathname.split(":").at(-1)) {
          case "signUp":
            if (accountExists) return upstreamError("EMAIL_EXISTS");
            accountExists = true;
            return Response.json(providerSession);
          case "update":
            return Response.json(providerSession);
          case "signInWithPassword":
            if (JSON.parse(body).password !== credentials.password) {
              return upstreamError("INVALID_LOGIN_CREDENTIALS");
            }
            return Response.json(providerSession);
          case "lookup":
            return Response.json({
              users: [{ ...user, emailVerified: verified }],
            });
          case "sendOobCode":
            if (failure === "email" && !failed) {
              failed = true;
              return upstreamError("INTERNAL_ERROR", 503);
            }
            emailSent = true;
            return Response.json({});
          default:
            assert.fail("Unexpected Identity Platform request");
        }
      },
    });
    const options = { env, client };
    await assert.rejects(registerUser(credentials, options), {
      code:
        failure === "email"
          ? "AUTH_UNAVAILABLE"
          : "TESTER_ACCESS_PERSISTENCE_FAILED",
    });
    assert.equal(accountExists, true);
    assert.equal(store.records.size, 0);

    await assert.rejects(
      registerUser({ ...credentials, password: "incorrect-password" }, options),
      { code: "AUTH_EMAIL_EXISTS", status: 409 },
    );
    assert.equal(store.records.size, 0);

    if (failure === "email") {
      await assert.rejects(signInUser(credentials, options), {
        code: "AUTH_EMAIL_VERIFICATION_RESENT",
      });
      verified = true;
      // A verified public account is not locked out by a missing access record.
      assert.equal(
        (await signInUser(credentials, options)).user.id,
        user.localId,
      );
      assert.equal(store.records.size, 0);
    }

    const recovered = await registerUser(credentials, options);
    assert.equal(recovered.user.id, user.localId);
    assert.equal(recovered.created, false);
    assert.equal(recovered.confirmationRequired, !verified);
    assert.equal(Boolean(recovered.session), verified);
    assert.equal(emailSent, true);
    const approval = store.records.get(accessId);
    assert.equal(approval.status, "approved");

    verified = true;
    assert.equal(
      (await signInUser(credentials, options)).user.id,
      user.localId,
    );
    assert.equal((await registerUser(credentials, options)).created, false);
    assert.equal(store.records.get(accessId), approval);

    store.records.set(accessId, { ...approval, status: "revoked" });
    await assert.rejects(registerUser(credentials, options), {
      code: "TESTER_ACCESS_NOT_APPROVED",
    });
    assert.equal(store.records.get(accessId).status, "revoked");
  }
});

test("public mode lets a verified account in without a tester record, invite mode does not", async () => {
  const verifiedUser = {
    id: "public-verified-user",
    email: "new@example.test",
    emailVerified: true,
    authProvider: "identity-platform",
  };
  const client = {
    auth: {
      async signInWithPassword() {
        return { data: { user: verifiedUser, session: session() }, error: null };
      },
      async getUser() {
        return { data: { user: verifiedUser }, error: null };
      },
    },
  };
  const credentials = { email: verifiedUser.email, password: "strong-pass-123" };

  for (const mode of ["public", "invite"]) {
    const env = { ...ENV, USER_REGISTRATION_MODE: mode };
    setFirestoreTesterAccessStoreForTests(accessStore());
    const cookie = userSessionCookie(session(), env);
    if (mode === "public") {
      const signedIn = await signInUser(credentials, { env, client });
      assert.equal(signedIn.user.id, verifiedUser.id);
      const resolved = await resolveUserSession(cookie, { env, client });
      assert.equal(resolved.user.id, verifiedUser.id);
      assert.equal(resolved.user.role, "member");
    } else {
      await assert.rejects(signInUser(credentials, { env, client }), {
        code: "TESTER_ACCESS_NOT_APPROVED",
      });
      assert.equal(await resolveUserSession(cookie, { env, client }), null);
    }
  }
});

test("public mode still blocks a revoked account", async () => {
  const env = { ...ENV, USER_REGISTRATION_MODE: "public" };
  const user = {
    id: "revoked-user",
    email: "revoked@example.test",
    emailVerified: true,
    authProvider: "identity-platform",
  };
  const store = accessStore();
  store.records.set(`identity-platform:${user.id}`, {
    userId: user.id,
    authProvider: "identity-platform",
    status: "revoked",
  });
  setFirestoreTesterAccessStoreForTests(store);
  const client = {
    auth: {
      async signInWithPassword() {
        return { data: { user, session: session() }, error: null };
      },
      async getUser() {
        return { data: { user }, error: null };
      },
    },
  };
  await assert.rejects(
    signInUser({ email: user.email, password: "strong-pass-123" }, { env, client }),
    { code: "ACCOUNT_ACCESS_REVOKED", status: 403 },
  );
  assert.equal(
    await resolveUserSession(userSessionCookie(session(), env), { env, client }),
    null,
  );
});

test("a Google account linked to the owner opens the owner's memory", async () => {
  const storedSession = session();
  const cookie = userSessionCookie(storedSession, ENV);
  const checked = [];
  const identity = await resolveUserSession(cookie, {
    env: { ...ENV, MEMORY_OWNER_ID: "owner-memory" },
    requireTesterAccess: async () => true,
    isPrimaryOwner: async (user) => {
      checked.push(user);
      return user.id === "google-owner";
    },
    client: {
      auth: {
        async getUser() {
          return {
            data: {
              user: {
                id: "google-owner",
                email: "owner@example.com",
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

  assert.equal(checked[0].authProvider, "identity-platform");
  assert.equal(identity.user.role, "owner");
  assert.equal(identity.user.memoryOwnerId, "owner-memory");
});
