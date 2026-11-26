import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../src/services/googleCloudActionService.js";
import {
  googleSignInRedirectUri,
  isGoogleSignInCallback,
  startGoogleSignIn,
} from "../src/services/googleSignInService.js";

const env = {
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  K_SERVICE: "synchron-backend-google",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "super-secret-value",
};

test("enable_google_sign_in is prepared without input and without the secret", async () => {
  let stored;
  const prepared = await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_google_sign_in", input: {}, env },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  assert.equal(stored.action, "infrastructure.write:enable_google_sign_in");
  assert.equal(prepared.resource.provider, "google.com");
  assert.doesNotMatch(JSON.stringify([stored, prepared]), /super-secret-value/u);
  await assert.rejects(
    prepareGoogleCloudAction(
      { ownerId: "owner", sessionId: "s", operation: "enable_google_sign_in", input: {}, env: { ...env, GOOGLE_CLIENT_SECRET: "" } },
      { createConfirmation: async () => ({ id: "x" }) },
    ),
    { code: "GOOGLE_CLOUD_OAUTH_CLIENT_MISSING" },
  );
});

async function confirmWith(fetchImpl) {
  let stored;
  await prepareGoogleCloudAction(
    { ownerId: "owner", sessionId: "s", operation: "enable_google_sign_in", input: {}, env },
    { createConfirmation: async (c) => ((stored = c), { id: "c1", expiresAt: 1 }) },
  );
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await confirmGoogleCloudAction(
      { ownerId: "owner", sessionId: "s", confirmationId: "c1" },
      {
        validateConfirmation: async () => stored,
        consumeConfirmation: async () => {},
        executeWrite: async ({ execute }) => execute(),
        adapters: { fetchImpl },
      },
    );
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function fakeGoogle({ exists }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      return { ok: true, json: async () => ({ access_token: "token" }) };
    }
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const missing = !exists && (options.method || "GET") === "GET";
    return {
      ok: !missing,
      status: missing ? 404 : 200,
      text: async () => (missing ? '{"error":{"status":"NOT_FOUND"}}' : "{}"),
    };
  };
  return { calls, fetchImpl };
}

test("an existing provider is updated; the result never contains the secret", async () => {
  const { calls, fetchImpl } = fakeGoogle({ exists: true });
  const result = await confirmWith(fetchImpl);
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH"]);
  assert.match(calls[1].url, /defaultSupportedIdpConfigs\/google\.com\?updateMask=enabled,clientId,clientSecret$/u);
  assert.equal(JSON.parse(calls[1].body).enabled, true);
  assert.deepEqual(result, {
    projectId: "handy-boulevard-479120-q9",
    provider: "google.com",
    enabled: true,
    created: false,
  });
});

test("a missing provider is created", async () => {
  const { calls, fetchImpl } = fakeGoogle({ exists: false });
  const result = await confirmWith(fetchImpl);
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "POST"]);
  assert.match(calls[1].url, /defaultSupportedIdpConfigs\?idpId=google\.com$/u);
  assert.equal(result.created, true);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-value/u);
});

test("sign-in reuses the registered Drive redirect address", () => {
  const shared = { GOOGLE_REDIRECT_URI: "https://cloudaicore.com/api/google/callback" };
  assert.equal(googleSignInRedirectUri(shared), "https://cloudaicore.com/api/google/callback");
  assert.equal(googleSignInRedirectUri({}), "https://cloudaicore.com/api/auth/google/callback");
  assert.equal(
    googleSignInRedirectUri({ GOOGLE_REDIRECT_URI: "https://cloudaicore.com/other" }),
    "https://cloudaicore.com/api/auth/google/callback",
  );
  const { cookie } = startGoogleSignIn({
    env: { ...env, ...shared, GOOGLE_SIGN_IN: "on", USER_REGISTRATION_MODE: "public" },
  });
  assert.match(cookie, /Path=\/api;/u);
  const state = /synchron_google_signin_state=([^;]+)/u.exec(cookie)[1];
  assert.equal(isGoogleSignInCallback({ state, cookieHeader: `synchron_google_signin_state=${state}` }), true);
  assert.equal(isGoogleSignInCallback({ state, cookieHeader: "synchron_google_state=" + state }), false);
  assert.equal(isGoogleSignInCallback({ state: "", cookieHeader: "" }), false);
});

test("the shared callback is routed before the owner-only Drive router", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(
    server.indexOf('app.get("/api/google/callback"') < server.indexOf('"/api/google",\n  requireOwnerSession'),
  );
});
