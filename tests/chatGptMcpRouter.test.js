import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createChatGptMcpRouter } from "../src/routes/chatGptMcpRouter.js";
import { CHATGPT_MCP_SCOPE } from "../src/services/mcpOAuthService.js";
import {
  createPublicAiBudgetContext,
  reservePublicAiCall,
} from "../src/services/publicAiBudget.js";

test("ChatGPT plugin exposes only its own tools and reserves credits for the verified member", async () => {
  const member = {
    id: "member",
    memoryOwnerId: "identity-platform:member",
    role: "member",
  };
  const reservations = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/mcp/chatgpt",
    createChatGptMcpRouter({
      verify(authorization, scopes, _env, options) {
        if (!authorization) return null;
        assert.deepEqual(scopes, [CHATGPT_MCP_SCOPE]);
        assert.equal(
          options.expectedResource,
          "https://cloudaicore.com/mcp/chatgpt",
        );
        return member;
      },
      assertGrant: async (identity) => assert.equal(identity, member),
      getUsage: async (identity) => {
        assert.equal(identity, member);
        return { remaining: 10 };
      },
      budget: createPublicAiBudgetContext({
        reserve: async (...args) => reservations.push(args),
      }),
      ask: async ({ input }) => {
        await reservePublicAiCall(input, "openai", "test");
        return "Test reply.";
      },
    }),
  );
  const call = (method, params, auth = true) => {
    const req = request(app)
      .post("/mcp/chatgpt")
      .send({ jsonrpc: "2.0", id: 1, method, params });
    return auth ? req.set("Authorization", "Bearer mock") : req;
  };
  const list = await call("tools/list", {}, false).expect(200);
  assert.deepEqual(
    list.body.result.tools.map((t) => t.name),
    ["ask_synchron_x", "get_synchron_x_balance"],
  );
  const askParams = {
    name: "ask_synchron_x",
    arguments: { question: "Hello" },
  };
  await call("tools/call", askParams, false)
    .expect(401)
    .expect("WWW-Authenticate", /oauth-protected-resource\/mcp\/chatgpt/);
  const rejected = await call("tools/call", {
    name: "get_personal_context",
  }).expect(200);
  assert.equal(rejected.body.error.code, -32602);
  const balance = await call("tools/call", {
    name: "get_synchron_x_balance",
  }).expect(200);
  assert.match(balance.body.result.content[0].text, /10/);
  assert.equal(reservations.length, 0);
  const response = await call("tools/call", askParams).expect(200);
  assert.equal(response.body.result.content[0].text, "Test reply.");
  assert.deepEqual(reservations, [
    [member, 3, { provider: "openai", model: "test" }],
  ]);
});
