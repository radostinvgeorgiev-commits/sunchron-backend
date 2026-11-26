import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMcpOAuthRouter } from "../src/routes/mcpOAuthRouter.js";
import {
  assertMcpGrantActive,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  resetMcpOAuthStateForTests,
  revokeMcpGrants,
  validateMcpAuthorizationRequest,
  verifyMcpAccessToken,
} from "../src/services/mcpOAuthService.js";

const clientId = "synchron-gemini-cli";
const callback = "http://127.0.0.1:7777/oauth/callback";
const verifier = "g".repeat(64);
const owner = {
  id: "google-test-owner",
  memoryOwnerId: "google-test-memory",
  role: "owner",
};
const registered = {
  client_id: clientId,
  client_name: "Gemini CLI",
  redirect_uris: [callback],
  scope: "synchron:read synchron:google.read offline_access",
};
const env = {
  MCP_ACCESS_TOKEN:
    "isolated-google-oauth-test-secret-longer-than-32-characters",
  MCP_RESOURCE_URL: "https://cloudaicore.com/mcp",
  MCP_GOOGLE_OAUTH_CLIENTS: JSON.stringify([registered]),
};
function input(overrides = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    state: "google-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: env.MCP_RESOURCE_URL,
    scope: "synchron:read",
    ...overrides,
  };
}
const noFetch = () => {
  throw new Error("Native client must not fetch remote metadata");
};
test.beforeEach(() => resetMcpOAuthStateForTests());

test("registered Google native client completes PKCE and preserves owner identity", async () => {
  const validated = await validateMcpAuthorizationRequest(input(), {
    env,
    fetchImpl: noFetch,
  });
  const code = createMcpAuthorizationCode(validated, owner, env);
  const token = await exchangeMcpAuthorizationCode(
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: env.MCP_RESOURCE_URL,
    },
    env,
  );
  const identity = verifyMcpAccessToken(
    `Bearer ${token.access_token}`,
    ["synchron:read"],
    env,
  );
  assert.equal(identity.id, owner.id);
  assert.equal(identity.memoryOwnerId, owner.memoryOwnerId);
  assert.equal(identity.clientId, clientId);
  await assertMcpGrantActive(identity, { env, client: null });
  await assert.rejects(
    exchangeMcpRefreshToken(
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: "synchron-antigravity",
        resource: env.MCP_RESOURCE_URL,
      },
      env,
    ),
  );
  assert.throws(() =>
    verifyMcpAccessToken(
      `Bearer ${token.access_token}`,
      ["synchron:github.write"],
      env,
    ),
  );
});

test("Google native clients fail closed without an exact operator registration", async () => {
  for (const raw of [
    undefined,
    "[]",
    "{}",
    "bad-json",
    JSON.stringify([registered, registered]),
  ]) {
    await assert.rejects(
      validateMcpAuthorizationRequest(input(), {
        env: { ...env, MCP_GOOGLE_OAUTH_CLIENTS: raw },
        fetchImpl: noFetch,
      }),
      (error) => error.code === "invalid_client",
    );
  }
  for (const redirect_uri of [
    "http://127.0.0.1:7778/oauth/callback",
    "http://localhost:7777/oauth/callback",
    "http://127.0.0.1.evil.example:7777/oauth/callback",
    `${callback}?x=1`,
    `${callback}#fragment`,
    "https://attacker.example/oauth/callback",
  ]) {
    await assert.rejects(
      validateMcpAuthorizationRequest(input({ redirect_uri }), {
        env,
        fetchImpl: noFetch,
      }),
      (error) => error.code === "invalid_client",
    );
  }
});

test("invalid native registration callbacks are rejected even when exactly requested", async () => {
  for (const uri of [
    "http://attacker.example:7777/oauth/callback",
    `${callback}?x=1`,
    "https://user:password@example.com/oauth/callback",
    "https://example.com/not-a-callback",
    `${callback}#x`,
  ]) {
    const invalidEnv = {
      ...env,
      MCP_GOOGLE_OAUTH_CLIENTS: JSON.stringify([
        { ...registered, redirect_uris: [uri] },
      ]),
    };
    await assert.rejects(
      validateMcpAuthorizationRequest(input({ redirect_uri: uri }), {
        env: invalidEnv,
        fetchImpl: noFetch,
      }),
    );
  }
});

test("Google scope and PKCE restrictions remain enforced", async () => {
  await assert.rejects(
    validateMcpAuthorizationRequest(
      input({ resource: "https://attacker.example/mcp" }),
      { env, fetchImpl: noFetch },
    ),
    (error) => error.code === "invalid_target",
  );
  await assert.rejects(
    validateMcpAuthorizationRequest(input({ scope: "synchron:github.write" }), {
      env,
      fetchImpl: noFetch,
    }),
    (error) => error.code === "invalid_scope",
  );
  await assert.rejects(
    validateMcpAuthorizationRequest(input({ code_challenge_method: "plain" }), {
      env,
      fetchImpl: noFetch,
    }),
  );
  const validated = await validateMcpAuthorizationRequest(
    input({ scope: "synchron:google.read" }),
    { env, fetchImpl: noFetch },
  );
  assert.throws(
    () =>
      createMcpAuthorizationCode(validated, { ...owner, role: "user" }, env),
    (error) => error.code === "access_denied",
  );
  const code = createMcpAuthorizationCode(validated, owner, env);
  await assert.rejects(
    exchangeMcpAuthorizationCode(
      {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: callback,
        code_verifier: "x".repeat(64),
        resource: env.MCP_RESOURCE_URL,
      },
      env,
    ),
  );
});

test("malformed Google configuration cannot disable the existing ChatGPT login", async () => {
  const chatId = "https://chatgpt.com/oauth/synchron/client.json";
  const chatCallback = "https://chatgpt.com/connector/oauth/test-callback";
  const validated = await validateMcpAuthorizationRequest(
    input({ client_id: chatId, redirect_uri: chatCallback }),
    {
      env: { ...env, MCP_GOOGLE_OAUTH_CLIENTS: "bad-json" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            client_id: chatId,
            client_name: "ChatGPT",
            redirect_uris: [chatCallback],
            token_endpoint_auth_method: "none",
          }),
        ),
    },
  );
  assert.equal(validated.clientId, chatId);
  assert.equal(validated.redirectUri, chatCallback);
});

test("Google grant revocation leaves the owner's ChatGPT grant active", async () => {
  const chatId = "https://chatgpt.com/oauth/synchron/client.json";
  const chatCallback = "https://chatgpt.com/connector/oauth/test-callback";
  const identities = [];
  for (const [id, uri] of [
    [clientId, callback],
    [chatId, chatCallback],
  ]) {
    const validated = await validateMcpAuthorizationRequest(
      input({ client_id: id, redirect_uri: uri }),
      {
        env,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              client_id: chatId,
              client_name: "ChatGPT",
              redirect_uris: [chatCallback],
              token_endpoint_auth_method: "none",
            }),
            { status: 200 },
          ),
      },
    );
    const code = createMcpAuthorizationCode(validated, owner, env);
    const token = await exchangeMcpAuthorizationCode(
      {
        grant_type: "authorization_code",
        code,
        client_id: id,
        redirect_uri: uri,
        code_verifier: verifier,
        resource: env.MCP_RESOURCE_URL,
      },
      env,
    );
    identities.push(
      verifyMcpAccessToken(
        `Bearer ${token.access_token}`,
        ["synchron:read"],
        env,
      ),
    );
  }
  assert.notEqual(identities[0].grantId, identities[1].grantId);
  await revokeMcpGrants({
    subject: owner.id,
    grantId: identities[0].grantId,
    env,
    client: null,
  });
  await assert.rejects(
    assertMcpGrantActive(identities[0], { env, client: null }),
  );
  await assertMcpGrantActive(identities[1], { env, client: null });
});

test("real Google consent route labels the client, binds callback CSP, and exchanges the code", async () => {
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  try {
    const app = express();
    app.use(createMcpOAuthRouter({ resolveIdentity: async () => owner }));
    const consent = await request(app)
      .get("/oauth/authorize")
      .query(input())
      .expect(200);
    assert.match(consent.text, /Свързване на Gemini CLI със AI CORE/u);
    assert.match(
      consent.headers["content-security-policy"],
      /http:\/\/127\.0\.0\.1:7777/u,
    );
    assert.doesNotMatch(consent.headers["content-security-policy"], /\*/u);
    const consentToken = consent.text.match(
      /name="consent_token" value="([^"]+)"/u,
    )?.[1];
    assert.ok(consentToken);
    const approved = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ consent_token: consentToken, decision: "allow" })
      .expect(302);
    const target = new URL(approved.headers.location);
    assert.equal(target.origin + target.pathname, callback);
    assert.equal(target.searchParams.get("state"), "google-state");
    assert.match(
      approved.headers["content-security-policy"],
      /http:\/\/127\.0\.0\.1:7777/u,
    );
    const token = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: target.searchParams.get("code"),
        client_id: clientId,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: env.MCP_RESOURCE_URL,
      })
      .expect(200);
    assert.equal(token.body.token_type, "Bearer");
    const denied = await request(app)
      .get("/oauth/authorize")
      .query(input({ redirect_uri: "https://evil.example/oauth/callback" }))
      .expect(400);
    assert.doesNotMatch(
      denied.headers["content-security-policy"],
      /evil\.example/u,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
