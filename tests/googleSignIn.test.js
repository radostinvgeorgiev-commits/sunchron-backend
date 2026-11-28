import assert from "node:assert/strict";
import test from "node:test";
import {
  finishGoogleSignIn,
  isGoogleSignInEnabled,
  startGoogleSignIn,
} from "../src/services/googleSignInService.js";

const env = {
  GOOGLE_SIGN_IN: "on",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  USER_REGISTRATION_MODE: "public",
};

test("Google sign-in is on by default, needs configuration and can be switched off", () => {
  assert.equal(isGoogleSignInEnabled({ ...env, GOOGLE_SIGN_IN: "" }), true);
  assert.equal(isGoogleSignInEnabled({ ...env, GOOGLE_SIGN_IN: "off" }), false);
  assert.equal(isGoogleSignInEnabled({ ...env, GOOGLE_CLIENT_SECRET: "" }), false);
  assert.equal(isGoogleSignInEnabled({ ...env, USER_REGISTRATION_MODE: "invite" }), false);
  assert.equal(isGoogleSignInEnabled(env), true);
});

test("start redirects to Google with a state that is also set as a cookie", () => {
  const { url, cookie } = startGoogleSignIn({ env });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://novariumai.com/api/auth/google/callback");
  assert.equal(parsed.searchParams.get("scope"), "openid email profile");
  const state = parsed.searchParams.get("state");
  assert.match(cookie, new RegExp(`synchron_google_signin_state=${state};`));
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/u);
});

function deps(overrides = {}) {
  const calls = { idp: null, approved: null };
  return {
    calls,
    options: {
      env,
      fetchImpl: async (_url, init) => {
        assert.equal(new URLSearchParams(init.body).get("client_secret"), "client-secret");
        return new Response(JSON.stringify({ id_token: "google-id-token" }), { status: 200 });
      },
      client: {
        auth: {
          async signInWithGoogleIdToken(args) {
            calls.idp = args;
            return overrides.idp || {
              data: {
                user: { id: "u1", email: "a@b.c", emailVerified: true },
                session: { access_token: "t", refresh_token: "r", expires_at: 9e9 },
                isNewUser: true,
              },
              error: null,
            };
          },
        },
      },
      approveAccess: async (user, opts) => {
        calls.approved = { user, opts };
      },
    },
  };
}

test("callback with matching state signs in through Identity Platform and approves access", async () => {
  const { calls, options } = deps();
  const result = await finishGoogleSignIn(
    { code: "c", state: "s1", cookieHeader: "x=1; synchron_google_signin_state=s1" },
    options,
  );
  assert.equal(calls.idp.idToken, "google-id-token");
  assert.equal(calls.approved.opts.createOnly, true);
  assert.equal(result.created, true);
  assert.equal(result.session.access_token, "t");
});

test("a forged or expired state is refused before any token exchange", async () => {
  const { calls, options } = deps();
  await assert.rejects(
    finishGoogleSignIn({ code: "c", state: "other", cookieHeader: "synchron_google_signin_state=s1" }, options),
    { code: "AUTH_GOOGLE_STATE_INVALID" },
  );
  assert.equal(calls.idp, null);
});

test("a disabled Google provider in Identity Platform is reported plainly", async () => {
  const { options } = deps({
    idp: { data: null, error: { upstreamCode: "OPERATION_NOT_ALLOWED" } },
  });
  await assert.rejects(
    finishGoogleSignIn({ code: "c", state: "s1", cookieHeader: "synchron_google_signin_state=s1" }, options),
    { code: "AUTH_GOOGLE_PROVIDER_DISABLED" },
  );
});

test("an email that already has a password profile is sent to the password sign-in, not lost", async () => {
  const { options } = deps({
    idp: { data: null, error: { upstreamCode: "NEED_CONFIRMATION" } },
  });
  await assert.rejects(
    finishGoogleSignIn({ code: "c", state: "s1", cookieHeader: "synchron_google_signin_state=s1" }, options),
    { code: "AUTH_GOOGLE_PASSWORD_ACCOUNT", status: 409 },
  );
});

test("Identity Platform needConfirmation becomes NEED_CONFIRMATION instead of a broken session", async () => {
  const { createIdentityPlatformAuthClient } = await import("../src/services/identityPlatformAuthClient.js");
  const client = createIdentityPlatformAuthClient({
    env: {
      AUTH_BACKEND: "identity-platform",
      IDENTITY_PLATFORM_API_KEY: "test-api-key-1234567890abcd",
      IDENTITY_PLATFORM_PROJECT_ID: "test-project",
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ needConfirmation: true, email: "a@b.c", providerId: "google.com" }), { status: 200 }),
  });
  const { data, error } = await client.auth.signInWithGoogleIdToken({ idToken: "x", requestUri: "https://novariumai.com/api/google/callback" });
  assert.equal(data, null);
  assert.equal(error.upstreamCode, "NEED_CONFIRMATION");
});
