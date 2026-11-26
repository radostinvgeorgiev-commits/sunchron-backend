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

test("Google sign-in stays off until it is switched on and configured", () => {
  assert.equal(isGoogleSignInEnabled({ ...env, GOOGLE_SIGN_IN: "" }), false);
  assert.equal(isGoogleSignInEnabled({ ...env, GOOGLE_CLIENT_SECRET: "" }), false);
  assert.equal(isGoogleSignInEnabled({ ...env, USER_REGISTRATION_MODE: "invite" }), false);
  assert.equal(isGoogleSignInEnabled(env), true);
});

test("start redirects to Google with a state that is also set as a cookie", () => {
  const { url, cookie } = startGoogleSignIn({ env });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://cloudaicore.com/api/auth/google/callback");
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
