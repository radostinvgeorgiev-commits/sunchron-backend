import assert from "node:assert/strict";
import test from "node:test";

import { createIdentityPlatformAuthClient } from "../src/services/identityPlatformAuthClient.js";

const ENV = Object.freeze({
  IDENTITY_PLATFORM_PROJECT_ID: "handy-boulevard-479120-q9",
  IDENTITY_PLATFORM_API_KEY: "identity-api-key-1234567890",
  IDENTITY_PLATFORM_TIMEOUT_MS: "5000",
  IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION: "false",
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

test("Identity Platform signs in and looks up users through fixed Google endpoints", async () => {
  const calls = [];
  const client = createIdentityPlatformAuthClient({
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("accounts:signInWithPassword")) {
        return response({
          localId: "identity-user-a",
          email: "friend@example.com",
          displayName: "Приятел",
          idToken: "identity-access-a",
          refreshToken: "identity-refresh-a",
          expiresIn: "3600",
        });
      }
      return response({
        users: [
          {
            localId: "identity-user-a",
            email: "friend@example.com",
            displayName: "Приятел",
            emailVerified: true,
          },
        ],
      });
    },
  });

  const signedIn = await client.auth.signInWithPassword({
    email: "friend@example.com",
    password: "strong-pass-123",
  });
  assert.equal(signedIn.error, null);
  assert.equal(signedIn.data.user.authProvider, "identity-platform");
  assert.equal(signedIn.data.session.access_token, "identity-access-a");
  const lookedUp = await client.auth.getUser("identity-access-a");
  assert.equal(lookedUp.data.user.emailVerified, true);

  assert.match(
    calls[0].url,
    /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword\?key=/u,
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email: "friend@example.com",
    password: "strong-pass-123",
    returnSecureToken: true,
  });
  assert.match(calls[1].url, /accounts:lookup\?key=/u);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    idToken: "identity-access-a",
  });
});

test("Identity Platform signup sets the display name without exposing server credentials", async () => {
  const calls = [];
  const client = createIdentityPlatformAuthClient({
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).includes("accounts:signUp")) {
        return response({
          localId: "identity-user-new",
          email: "new@example.com",
          idToken: "signup-token",
          refreshToken: "signup-refresh",
          expiresIn: "3600",
        });
      }
      return response({
        localId: "identity-user-new",
        email: "new@example.com",
        displayName: "Нов тестер",
        idToken: "updated-token",
        refreshToken: "updated-refresh",
        expiresIn: "3600",
      });
    },
  });

  const result = await client.auth.signUp({
    email: "new@example.com",
    password: "strong-pass-123",
    options: { data: { display_name: "Нов тестер" } },
  });

  assert.equal(result.error, null);
  assert.equal(result.data.user.displayName, "Нов тестер");
  assert.equal(result.data.session.access_token, "updated-token");
  assert.deepEqual(
    calls.map(({ body }) => body),
    [
      {
        email: "new@example.com",
        password: "strong-pass-123",
        returnSecureToken: true,
      },
      {
        idToken: "signup-token",
        displayName: "Нов тестер",
        returnSecureToken: true,
      },
    ],
  );
});

test("Identity Platform refresh uses Secure Token and revalidates the user", async () => {
  const calls = [];
  const client = createIdentityPlatformAuthClient({
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: String(options.body) });
      if (String(url).startsWith("https://securetoken.googleapis.com")) {
        return response({
          id_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: "3600",
          token_type: "Bearer",
        });
      }
      return response({
        users: [{ localId: "identity-user-a", email: "friend@example.com" }],
      });
    },
  });

  const result = await client.auth.refreshSession({
    refresh_token: "old-refresh",
  });
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, "refreshed-access");
  assert.equal(result.data.user.id, "identity-user-a");
  assert.match(calls[0].url, /^https:\/\/securetoken\.googleapis\.com/u);
  assert.equal(
    calls[0].body,
    "grant_type=refresh_token&refresh_token=old-refresh",
  );
});

test("Identity Platform signup requires a verification email before creating an app session", async () => {
  const calls = [];
  const client = createIdentityPlatformAuthClient({
    env: { ...ENV, IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION: "true" },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).includes("accounts:signUp")) {
        return response({
          localId: "identity-user-new",
          email: "new@example.com",
          idToken: "signup-token",
          refreshToken: "signup-refresh",
          expiresIn: "3600",
        });
      }
      if (String(url).includes("accounts:update")) {
        return response({
          localId: "identity-user-new",
          email: "new@example.com",
          displayName: "Нов тестер",
          idToken: "updated-token",
          refreshToken: "updated-refresh",
          expiresIn: "3600",
        });
      }
      return response({ email: "new@example.com" });
    },
  });

  const result = await client.auth.signUp({
    email: "new@example.com",
    password: "strong-pass-123",
    options: { data: { display_name: "Нов тестер" } },
  });
  assert.equal(result.error, null);
  assert.equal(result.data.session, null);
  assert.equal(result.data.confirmationRequired, true);
  assert.match(calls.at(-1).url, /accounts:sendOobCode\?key=/u);
  assert.deepEqual(calls.at(-1).body, {
    requestType: "VERIFY_EMAIL",
    idToken: "updated-token",
  });
});

test("Identity Platform errors are bounded and do not contain API keys or passwords", async () => {
  const client = createIdentityPlatformAuthClient({
    env: ENV,
    fetchImpl: async () =>
      response(
        { error: { message: "INVALID_PASSWORD : sensitive upstream text" } },
        400,
      ),
  });
  const result = await client.auth.signInWithPassword({
    email: "friend@example.com",
    password: "private-password",
  });
  assert.equal(result.error.upstreamCode, "INVALID_PASSWORD");
  assert.doesNotMatch(
    JSON.stringify(result.error),
    /identity-api-key|private-password|sensitive upstream text/u,
  );
});
