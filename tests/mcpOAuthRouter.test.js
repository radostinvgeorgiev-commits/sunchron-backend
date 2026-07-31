import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createMcpOAuthRouter } from "../src/routes/mcpOAuthRouter.js";
import mcpRouter from "../src/routes/mcpRouter.js";

const SECRET = "router-test-secret-with-more-than-thirty-two-characters";

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
  assert.equal(listed.body.result.tools.length, 11);
  assert.equal(listed.body.result.tools[0].securitySchemes[0].type, "oauth2");
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
    .expect(200);
  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result._meta["mcp/www_authenticate"][0],
    /oauth-protected-resource/u,
  );
  assert.match(response.headers["www-authenticate"], /synchron:read/u);
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
  assert.equal(response.body.error.code, -32001);
  assert.match(response.headers["www-authenticate"], /invalid_token/u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});

test("authorization consent issues a code bound to the browser profile", async () => {
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
  assert.match(consent.text, /Свързване на ChatGPT със SYNCHRON-X/u);
  const csrf = consent.text.match(/name="csrf_token" value="([^"]+)"/u)?.[1];
  assert.ok(csrf);
  const approved = await request(app)
    .post("/oauth/authorize")
    .set("Cookie", `synchron_mcp_csrf=${csrf}`)
    .type("form")
    .send({ csrf_token: csrf, decision: "allow" })
    .expect(302);
  const callback = new URL(approved.headers.location);
  assert.equal(callback.origin, "https://chatgpt.com");
  assert.equal(callback.searchParams.get("state"), "state-123");
  assert.match(callback.searchParams.get("code"), /^sx-code\./u);
  if (previous === undefined) delete process.env.MCP_ACCESS_TOKEN;
  else process.env.MCP_ACCESS_TOKEN = previous;
});
