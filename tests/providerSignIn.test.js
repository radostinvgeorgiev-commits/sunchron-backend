import assert from "node:assert/strict";
import test from "node:test";
import {
  finishProviderSignIn,
  isProviderSignInEnabled,
  providerCallbackUri,
  providerSignInStatus,
  startProviderSignIn,
} from "../src/services/providerSignInService.js";
import { createProviderSignInHandlers } from "../src/routes/userAuthRouter.js";

const env = { FACEBOOK_SIGN_IN: "on", MICROSOFT_SIGN_IN: "on", USER_REGISTRATION_MODE: "public" };

test("Facebook and Microsoft stay off until switched on", () => {
  assert.deepEqual(providerSignInStatus({ USER_REGISTRATION_MODE: "public" }), { facebook: false, microsoft: false });
  assert.deepEqual(providerSignInStatus(env), { facebook: true, microsoft: true });
  assert.equal(isProviderSignInEnabled("facebook", { ...env, USER_REGISTRATION_MODE: "invite" }), false);
  assert.throws(() => isProviderSignInEnabled("evil", env), { code: "AUTH_PROVIDER_UNKNOWN" });
  assert.equal(providerCallbackUri("facebook", {}), "https://novariumai.com/api/auth/facebook/callback");
});

function client(overrides = {}) {
  const calls = {};
  return {
    calls,
    auth: {
      async createProviderAuthUri(args) {
        calls.create = args;
        return overrides.create || { data: { authUri: "https://www.facebook.com/dialog/oauth?x=1", sessionId: "sess/1+2" }, error: null };
      },
      async signInWithProviderRedirect(args) {
        calls.signIn = args;
        return overrides.signIn || {
          data: {
            user: { id: "u1", email: "a@b.c" },
            session: { access_token: "t", refresh_token: "r", expires_at: 9e9 },
            isNewUser: true,
          },
          error: null,
        };
      },
    },
  };
}

test("start asks Identity Platform for the provider address and keeps its session in a cookie", async () => {
  const c = client();
  const { url, cookie } = await startProviderSignIn("facebook", { env, client: c });
  assert.equal(url, "https://www.facebook.com/dialog/oauth?x=1");
  assert.equal(c.calls.create.providerId, "facebook.com");
  assert.equal(c.calls.create.continueUri, "https://novariumai.com/api/auth/facebook/callback");
  assert.match(cookie, /^synchron_facebook_signin_session=sess%2F1%2B2; Path=\/api\/auth\/facebook; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/u);
});

test("callback signs in with the full callback address and the session from the cookie", async () => {
  const c = client();
  let approved;
  const result = await finishProviderSignIn(
    "microsoft",
    {
      query: { code: "abc" },
      cookieHeader: "x=1; synchron_microsoft_signin_session=sess%2F1%2B2",
      originalUrl: "/api/auth/microsoft/callback?code=abc&state=s",
    },
    { env, client: c, approveAccess: async (_u, opts) => (approved = opts) },
  );
  assert.equal(c.calls.signIn.requestUri, "https://novariumai.com/api/auth/microsoft/callback?code=abc&state=s");
  assert.equal(c.calls.signIn.sessionId, "sess/1+2");
  assert.equal(approved.createOnly, true);
  assert.equal(result.created, true);
});

test("a callback without the starting cookie is refused before Identity Platform", async () => {
  const c = client();
  await assert.rejects(
    finishProviderSignIn("facebook", { query: { code: "x" }, cookieHeader: "", originalUrl: "/api/auth/facebook/callback?code=x" }, { env, client: c }),
    { code: "AUTH_FACEBOOK_STATE_INVALID" },
  );
  assert.equal(c.calls.signIn, undefined);
});

test("an email that already has a profile is told how to sign in, not merged", async () => {
  const c = client({ signIn: { data: null, error: { upstreamCode: "NEED_CONFIRMATION" } } });
  await assert.rejects(
    finishProviderSignIn(
      "facebook",
      { query: { code: "x" }, cookieHeader: "synchron_facebook_signin_session=s", originalUrl: "/cb?code=x" },
      { env, client: c },
    ),
    { code: "AUTH_FACEBOOK_EXISTING_ACCOUNT" },
  );
});

test("a provider not yet enabled in Identity Platform is reported plainly", async () => {
  const c = client({ create: { data: null, error: { upstreamCode: "OPERATION_NOT_ALLOWED" } } });
  await assert.rejects(startProviderSignIn("microsoft", { env, client: c }), { code: "AUTH_MICROSOFT_PROVIDER_DISABLED" });
});

test("the route redirects home with the session cookie, or back with the error code", async () => {
  const handlers = createProviderSignInHandlers("facebook", {
    finish: async () => ({ session: { access_token: "t", refresh_token: "r", expires_at: 9e9 }, created: false }),
    start: async () => {
      throw Object.assign(new Error("x"), { code: "AUTH_FACEBOOK_DISABLED" });
    },
    logError: () => {},
  });
  const res = () => {
    const out = { headers: {} };
    out.setHeader = (k, v) => (out.headers[k] = v);
    out.redirect = (status, url) => Object.assign(out, { status, url });
    return out;
  };
  const started = res();
  await handlers.start({}, started);
  assert.equal(started.url, "/?auth_error=AUTH_FACEBOOK_DISABLED");
});
