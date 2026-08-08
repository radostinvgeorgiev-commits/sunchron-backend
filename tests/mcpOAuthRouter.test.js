import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createMcpOAuthRouter } from "../src/routes/mcpOAuthRouter.js";
import {
  getMcpOAuthRuntimeStatus,
  resetMcpOAuthStateForTests,
  revokeMcpGrants,
} from "../src/services/mcpOAuthService.js";
import mcpRouter, {
  mcpJsonParseErrorHandler,
  requireMcpAuthorization,
} from "../src/routes/mcpRouter.js";

const SECRET = "router-test-secret-with-more-than-thirty-two-characters";
const DEDICATED_SECRET =
  "router-dedicated-oauth-secret-with-more-than-thirty-two-characters";

function assertMcpOAuthChallenge(response) {
  const challenge = response.headers["www-authenticate"];
  assert.equal(response.body.result?.isError, true);
  assert.equal(response.body.result?.content?.[0]?.type, "text");
  assert.ok(response.body.result?.content?.[0]?.text);
  assert.deepEqual(response.body.result?._meta?.["mcp/www_authenticate"], [
    challenge,
  ]);
  return challenge;
}

test("OAuth discovery is public and describes the exact MCP resource", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  const app = express();
  app.use(createMcpOAuthRouter());
  const resource = await request(app)
    .get("/.well-known/oauth-protected-resource")
    .expect(200);
  assert.equal(resource.body.resource, "https://synchron.foundation/mcp");
  const authorization = await request(app)
    .get("/.well-known/oauth-authorization-server")
    .expect(200);
  assert.equal(
    authorization.body.token_endpoint,
    "https://synchron.foundation/oauth/token",
  );
  assert.ok(authorization.body.scopes_supported.includes("offline_access"));
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});

test("MCP initialize and tool discovery work without credentials", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const initialized = await request(app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize" })
    .expect(200);
  assert.equal(initialized.body.result.serverInfo.name, "synchron-x-memory");
  const listed = await request(app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    .expect(200);
  assert.equal(listed.body.result.tools.length, 50);
  assert.deepEqual(listed.body.result.tools[0].securitySchemes, [
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
  const publicStatus = listed.body.result.tools.find(
    (tool) => tool.name === "get_digitalocean_app_status",
  );
  assert.deepEqual(publicStatus.securitySchemes, [
    { type: "noauth" },
    { type: "oauth2", scopes: ["synchron:read"] },
  ]);
  assert.deepEqual(
    listed.body.result.tools.find((tool) => tool.name === "send_message")
      .securitySchemes,
    [{ type: "oauth2", scopes: ["synchron:agent.chat"] }],
  );
  assert.deepEqual(
    listed.body.result.tools.find(
      (tool) => tool.name === "confirm_google_action",
    ).securitySchemes,
    [{ type: "oauth2", scopes: ["synchron:google.write"] }],
  );
});

test("only the redacted production status can pass without credentials", async () => {
  const app = express();
  app.use(express.json());
  app.post("/mcp", requireMcpAuthorization, (req, res) =>
    res.json({ authentication: req.mcpAuthentication }),
  );
  const publicStatus = await request(app)
    .post("/mcp")
    .send({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "get_digitalocean_app_status", arguments: {} },
    })
    .expect(200);
  assert.equal(publicStatus.body.authentication.mode, "noauth");
  assert.equal(publicStatus.body.authentication.role, "anonymous");
});

test("MCP rejects an untrusted Origin", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .set("Origin", "https://evil.example")
    .send({ jsonrpc: "2.0", id: 20, method: "initialize" })
    .expect(403);
  assert.equal(response.body.error.code, -32000);
});

test("MCP accepts a trusted Origin", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .set("Origin", "https://chatgpt.com")
    .send({ jsonrpc: "2.0", id: 21, method: "initialize" })
    .expect(200);
  assert.equal(response.body.result.protocolVersion, "2025-06-18");
});

test("MCP rejects an unsupported protocol version after initialization", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .set("MCP-Protocol-Version", "invalid")
    .send({ jsonrpc: "2.0", id: 22, method: "tools/list" })
    .expect(400);
  assert.equal(response.body.error.code, -32600);
});

test("MCP returns a JSON-RPC parse error for malformed JSON", async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpJsonParseErrorHandler, mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .set("Content-Type", "application/json")
    .send("{bad json")
    .expect(400);
  assert.equal(response.type, "application/json");
  assert.equal(response.body.error.code, -32700);
});

test("an unauthenticated tool call returns the ChatGPT OAuth challenge", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_personal_context", arguments: {} },
    })
    .expect(401);
  const challenge = assertMcpOAuthChallenge(response);
  assert.match(challenge, /oauth-protected-resource/u);
  assert.match(challenge, /synchron:read/u);
  assert.match(challenge, /error="invalid_token"/u);
  assert.match(challenge, /error_description="[^"]+"/u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});

test("an invalid bearer token is rejected with HTTP 401", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  const response = await request(app)
    .post("/mcp")
    .set("Authorization", "Bearer invalid-token")
    .send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_personal_context", arguments: {} },
    })
    .expect(401);
  const challenge = assertMcpOAuthChallenge(response);
  assert.match(challenge, /invalid_token/u);
  assert.match(challenge, /error_description="[^"]+"/u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});

test("the dedicated OAuth secret is never accepted as a legacy static bearer", async () => {
  const previousAccess = process.env.MCP_ACCESS_TOKEN;
  const previousOAuth = process.env.MCP_OAUTH_SECRET;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  process.env.MCP_OAUTH_SECRET = DEDICATED_SECRET;
  try {
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpRouter);
    const response = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${DEDICATED_SECRET}`)
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_personal_context", arguments: {} },
      })
      .expect(401);
    assertMcpOAuthChallenge(response);
  } finally {
    if (previousAccess === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = previousAccess;
    if (previousOAuth === undefined) delete process.env.MCP_OAUTH_SECRET;
    else process.env.MCP_OAUTH_SECRET = previousOAuth;
  }
});

test("authorization consent issues a code bound to the browser profile", async () => {
  resetMcpOAuthStateForTests();
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  const verifier = "v".repeat(64);
  const oauthRequest = {
    clientId: "https://chatgpt.com/oauth/synchron/client.json",
    clientName: "ChatGPT",
    redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
    state: "state-123",
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: "https://synchron.foundation/mcp",
    scopes: ["synchron:read"],
  };
  const app = express();
  app.use(
    createMcpOAuthRouter({
      resolveIdentity: async () => ({
        id: "owner-id",
        displayName: "Радко",
        role: "owner",
        memoryOwnerId: "primary-user",
      }),
      validateRequest: async () => oauthRequest,
    }),
  );
  const consent = await request(app).get("/oauth/authorize").expect(200);
  assert.equal(consent.headers["cross-origin-opener-policy"], "unsafe-none");
  assert.match(consent.text, /Свързване на ChatGPT със AI CORE/u);
  assert.match(consent.text, /Четене на разрешените данни/u);
  assert.match(consent.text, /отделно точно потвърждение/u);
  assert.match(consent.text, /AI CORE → Разрешения/u);
  const consentToken = consent.text.match(
    /name="consent_token" value="([^"]+)"/u,
  )?.[1];
  assert.ok(consentToken);
  assert.equal(consent.headers["set-cookie"], undefined);
  const approved = await request(app)
    .post("/oauth/authorize")
    .type("form")
    .send({ consent_token: consentToken, decision: "allow" })
    .expect(302);
  assert.equal(approved.headers["cross-origin-opener-policy"], "unsafe-none");
  const callback = new URL(approved.headers.location);
  assert.equal(callback.origin, "https://chatgpt.com");
  assert.equal(callback.searchParams.get("state"), "state-123");
  assert.equal(callback.searchParams.has("iss"), false);
  assert.match(callback.searchParams.get("code"), /^sx-code\./u);
  const authorizationStatus = getMcpOAuthRuntimeStatus();
  assert.equal(authorizationStatus.authorization, "redirected");
  assert.equal(authorizationStatus.authorizationDecision, "allow");
  assert.equal(authorizationStatus.authorizationErrorCode, null);
  assert.match(
    authorizationStatus.authorizationUpdatedAt,
    /^\d{4}-\d{2}-\d{2}T/u,
  );
  const token = await request(app)
    .post("/oauth/token")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: oauthRequest.clientId,
      redirect_uri: oauthRequest.redirectUri,
      code_verifier: verifier,
      resource: oauthRequest.resource,
    })
    .expect(200);
  assert.equal(token.body.token_type, "Bearer");
  assert.ok(token.body.refresh_token);

  const protectedApp = express();
  protectedApp.use(express.json());
  protectedApp.post("/mcp", requireMcpAuthorization, (_req, res) =>
    res.json({ ok: true }),
  );
  const insufficientScope = await request(protectedApp)
    .post("/mcp")
    .set("Authorization", `Bearer ${token.body.access_token}`)
    .send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "confirm_github_merged_branch_cleanup",
        arguments: {},
      },
    })
    .expect(403);
  const insufficientChallenge = assertMcpOAuthChallenge(insufficientScope);
  assert.match(insufficientChallenge, /insufficient_scope/u);
  assert.match(insufficientChallenge, /synchron:github\.write/u);
  assert.match(insufficientChallenge, /error_description="[^"]+"/u);

  const unavailableApp = express();
  unavailableApp.use(express.json());
  unavailableApp.post(
    "/mcp",
    (req, res, next) =>
      requireMcpAuthorization(req, res, next, {
        env: { ...process.env, NODE_ENV: "production", MCP_ACCESS_TOKEN: SECRET },
      }),
    (_req, res) => res.json({ ok: true }),
  );
  const unavailable = await request(unavailableApp)
    .post("/mcp")
    .set("Authorization", `Bearer ${token.body.access_token}`)
    .send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "get_personal_context", arguments: {} },
    })
    .expect(503);
  assert.equal(unavailable.body.error.code, -32002);
  assert.equal(unavailable.headers["www-authenticate"], undefined);

  assert.equal(
    await revokeMcpGrants({ subject: "owner-id", client: null }),
    1,
  );
  const revokedAccess = await request(protectedApp)
    .post("/mcp")
    .set("Authorization", `Bearer ${token.body.access_token}`)
    .send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_personal_context", arguments: {} },
    })
    .expect(401);
  const revokedChallenge = assertMcpOAuthChallenge(revokedAccess);
  assert.match(revokedChallenge, /error="invalid_token"/u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});

test("authorization flow permits only the ChatGPT callback through global browser isolation", async () => {
  resetMcpOAuthStateForTests();
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  try {
    const oauthRequest = {
      clientId: "https://chatgpt.com/oauth/synchron/client.json",
      clientName: "ChatGPT",
      redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
      state: "state-popup-handoff",
      codeChallenge: "c".repeat(43),
      resource: "https://synchron.foundation/mcp",
      scopes: ["synchron:read"],
    };
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; form-action 'self'; frame-ancestors 'none'",
      );
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      next();
    });
    app.use(
      createMcpOAuthRouter({
        resolveIdentity: async () => ({
          id: "owner-id",
          displayName: "Радко",
          role: "owner",
          memoryOwnerId: "primary-user",
        }),
        validateRequest: async () => oauthRequest,
      }),
    );

    const consent = await request(app).get("/oauth/authorize").expect(200);
    const consentToken = consent.text.match(
      /name="consent_token" value="([^"]+)"/u,
    )?.[1];
    assert.ok(consentToken);
    assert.equal(consent.headers["cross-origin-opener-policy"], "unsafe-none");
    assert.match(
      consent.headers["content-security-policy"],
      /form-action 'self' https:\/\/chatgpt\.com/u,
    );
    assert.doesNotMatch(
      consent.headers["content-security-policy"],
      /attacker\.example/u,
    );

    const approved = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ consent_token: consentToken, decision: "allow" })
      .expect(302);
    const callback = new URL(approved.headers.location);
    assert.equal(callback.origin, "https://chatgpt.com");
    assert.equal(callback.pathname, "/connector/oauth/test-callback");
    assert.equal(callback.searchParams.get("state"), oauthRequest.state);
    assert.match(callback.searchParams.get("code"), /^sx-code\./u);
    assert.equal(approved.headers["cross-origin-opener-policy"], "unsafe-none");
    assert.match(
      approved.headers["content-security-policy"],
      /form-action 'self' https:\/\/chatgpt\.com/u,
    );
    assert.equal(
      approved.headers["cross-origin-resource-policy"],
      "same-origin",
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = previous;
  }
});

test("authorization denial returns a no-store error to the exact ChatGPT callback", async () => {
  resetMcpOAuthStateForTests();
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  try {
    const oauthRequest = {
      clientId: "https://chatgpt.com/oauth/synchron/client.json",
      clientName: "ChatGPT",
      redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
      state: "state-denied",
      codeChallenge: "c".repeat(43),
      resource: "https://synchron.foundation/mcp",
      scopes: ["synchron:read"],
    };
    const app = express();
    app.use(
      createMcpOAuthRouter({
        resolveIdentity: async () => ({
          id: "owner-id",
          displayName: "Радко",
          role: "owner",
          memoryOwnerId: "primary-user",
        }),
        validateRequest: async () => oauthRequest,
      }),
    );
    const consent = await request(app).get("/oauth/authorize").expect(200);
    const consentToken = consent.text.match(
      /name="consent_token" value="([^"]+)"/u,
    )?.[1];
    assert.ok(consentToken);

    const denied = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ consent_token: consentToken, decision: "deny" })
      .expect(302);
    const callback = new URL(denied.headers.location);
    assert.equal(callback.origin, "https://chatgpt.com");
    assert.equal(callback.pathname, "/connector/oauth/test-callback");
    assert.equal(callback.searchParams.get("state"), oauthRequest.state);
    assert.equal(callback.searchParams.get("error"), "access_denied");
    assert.equal(callback.searchParams.has("code"), false);
    assert.equal(denied.headers["cache-control"], "no-store");
    assert.equal(denied.headers.pragma, "no-cache");
  } finally {
    if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = previous;
  }
});

test("authorization consent rejects a modified browser-independent token", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  try {
    const oauthRequest = {
      clientId: "https://chatgpt.com/oauth/synchron/client.json",
      clientName: "ChatGPT",
      redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
      state: "state-tampered-consent",
      codeChallenge: "c".repeat(43),
      resource: "https://synchron.foundation/mcp",
      scopes: ["synchron:read"],
    };
    const app = express();
    app.use(
      createMcpOAuthRouter({
        resolveIdentity: async () => ({
          id: "owner-id",
          displayName: "Радко",
          role: "owner",
          memoryOwnerId: "primary-user",
        }),
        validateRequest: async () => oauthRequest,
      }),
    );
    const consent = await request(app).get("/oauth/authorize").expect(200);
    const consentToken = consent.text.match(
      /name="consent_token" value="([^"]+)"/u,
    )?.[1];
    assert.ok(consentToken);
    const [prefix, encoded] = consentToken.split(".");
    const tamperedToken = `${prefix}.${encoded.startsWith("A") ? "B" : "A"}${encoded.slice(1)}`;
    const response = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({ consent_token: tamperedToken, decision: "allow" })
      .expect(403);
    assert.equal(response.body.error, "access_denied");
    assert.equal(response.body.error_description, "Невалидно потвърждение.");
  } finally {
    if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = previous;
  }
});

test("authorization consent ignores altered repeated OAuth form fields", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  try {
    const oauthRequest = {
      clientId: "https://chatgpt.com/oauth/synchron/client.json",
      clientName: "ChatGPT",
      redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
      state: "state-browser-round-trip",
      codeChallenge: "c".repeat(43),
      resource: "https://synchron.foundation/mcp",
      scopes: ["synchron:read"],
    };
    const app = express();
    app.use(
      createMcpOAuthRouter({
        resolveIdentity: async () => ({
          id: "owner-id",
          displayName: "Радко",
          role: "owner",
          memoryOwnerId: "primary-user",
        }),
        validateRequest: async () => oauthRequest,
      }),
    );
    const consent = await request(app).get("/oauth/authorize").expect(200);
    const consentToken = consent.text.match(
      /name="consent_token" value="([^"]+)"/u,
    )?.[1];
    assert.ok(consentToken);
    assert.doesNotMatch(consent.text, /name="state"/u);
    const approved = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        consent_token: consentToken,
        decision: "allow",
        state: "altered-by-browser",
        redirect_uri: "https://attacker.example/callback",
      })
      .expect(302);
    const callback = new URL(approved.headers.location);
    assert.equal(callback.origin, "https://chatgpt.com");
    assert.equal(callback.searchParams.get("state"), oauthRequest.state);
    assert.match(callback.searchParams.get("code"), /^sx-code\./u);
  } finally {
    if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = previous;
  }
});

test("authorization consent names the AI CORE conversation permission", async () => {
  const previous = process.env.MCP_ACCESS_TOKEN;
  process.env.MCP_ACCESS_TOKEN = SECRET;
  const app = express();
  app.use(
    createMcpOAuthRouter({
      resolveIdentity: async () => ({
        id: "owner-id",
        displayName: "Радко",
        role: "owner",
        memoryOwnerId: "primary-user",
      }),
      validateRequest: async () => ({
        clientId: "https://chatgpt.com/oauth/synchron/client.json",
        clientName: "ChatGPT",
        redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
        state: "state-agent-chat",
        codeChallenge: "challenge",
        resource: "https://synchron.foundation/mcp",
        scopes: ["synchron:agent.chat"],
      }),
    }),
  );
  const consent = await request(app).get("/oauth/authorize").expect(200);
  assert.match(consent.text, /Разговор с AI CORE в собствения профил/u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});
