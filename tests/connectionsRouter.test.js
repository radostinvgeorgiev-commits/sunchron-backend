import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";

import {
  connectionClientName,
  createConnectionsRouter,
} from "../src/routes/connectionsRouter.js";

function appFor(owner, overrides = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = owner;
    next();
  });
  app.use(
    "/api/connections",
    createConnectionsRouter({
      isConfigured: async () => true,
      resourceUrl: () => "https://cloudaicore.com/mcp",
      listGrants: async (input) => {
        calls.push(["list", input]);
        return [
          {
            grantId: "g1",
            clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
            scopes: ["synchron:read"],
            issuedAt: "2026-11-24T10:00:00.000Z",
            lastUsedAt: "2026-11-24T12:00:00.000Z",
            refreshTokenHash: "secret-hash",
          },
        ];
      },
      revokeGrants: async (input) => {
        calls.push(["revoke", input]);
        return { revoked: input.grantId === "g1" ? 1 : 0 };
      },
      audit: async (event) => calls.push(["audit", event]),
      ...overrides,
    }),
  );
  return { app, calls };
}

test("a member lists only their own connections without secrets", async () => {
  const { app, calls } = appFor({ id: "member-1", role: "member" });
  const response = await request(app).get("/api/connections").expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.mcpUrl, "https://cloudaicore.com/mcp");
  assert.deepEqual(response.body.connections, [
    {
      grantId: "g1",
      client: "Claude",
      issuedAt: "2026-11-24T10:00:00.000Z",
      lastUsedAt: "2026-11-24T12:00:00.000Z",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /secret-hash|scopes/u);
  assert.deepEqual(calls[0], ["list", { subject: "member-1" }]);
});

test("revoking is scoped to the caller and audited", async () => {
  const { app, calls } = appFor({ id: "member-1", role: "member" });
  await request(app)
    .post("/api/connections/revoke")
    .send({ grantId: "g1", subject: "someone-else" })
    .expect(200);
  assert.deepEqual(calls[0], ["revoke", { subject: "member-1", grantId: "g1" }]);
  assert.equal(calls[1][0], "audit");
  await request(app)
    .post("/api/connections/revoke")
    .send({ grantId: "missing" })
    .expect(404);
  await request(app).post("/api/connections/revoke").send({}).expect(400);
});

test("anonymous requests and storage failures are handled safely", async () => {
  const { app } = appFor(undefined);
  await request(app).get("/api/connections").expect(401);
  const failing = appFor(
    { id: "member-1" },
    {
      listGrants: async () => {
        throw new Error("store down");
      },
    },
  );
  const response = await request(failing.app).get("/api/connections").expect(503);
  assert.equal(response.body.code, "CONNECTIONS_UNAVAILABLE");
});

test("client names are recognised for common assistants", () => {
  assert.equal(connectionClientName("synchron-claude"), "Claude");
  assert.equal(connectionClientName("https://chatgpt.com/connector"), "ChatGPT");
  assert.equal(connectionClientName("synchron-gemini-cli"), "Gemini");
  assert.equal(connectionClientName("https://agent.example.com/meta"), "agent.example.com");
  assert.equal(connectionClientName(""), "AI клиент");
});

test("the connections route is mounted for every signed-in account", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const mount = server.slice(server.indexOf('"/api/connections"') - 20, server.indexOf("connectionsRouter,\n);"));
  assert.match(mount, /requireOwnerSession/u);
  assert.doesNotMatch(mount, /requirePrimaryOwner/u);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="connectionsBtn"/u);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/u);
});
