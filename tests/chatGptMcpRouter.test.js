import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { JSDOM } from "jsdom";
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
  const turns = [];
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
      listMessages: async (sessionId, limit, ownerId) => {
        assert.equal(sessionId, turns.at(-1)[0]);
        assert.equal(limit, 8);
        assert.equal(ownerId, member.memoryOwnerId);
        return [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Test reply." },
        ];
      },
      saveTurn: async (...args) => turns.push(args),
      ask: async ({ input }) => {
        if (turns.length) assert.equal(input[0].content, "Hello");
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
    ["open_synchron_x_workspace", "ask_synchron_x", "get_synchron_x_balance"],
  );
  const uri = list.body.result.tools[0]._meta.ui.resourceUri;
  const widget = await call("resources/read", { uri }, false).expect(200);
  assert.equal(
    widget.body.result.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.match(widget.body.result.contents[0].text, /id="composer"/u);
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
  const sessionId = response.body.result.structuredContent.sessionId;
  assert.match(sessionId, /^chatgpt-/u);
  assert.deepEqual(turns[0], [
    sessionId,
    "Hello",
    "Test reply.",
    member.memoryOwnerId,
  ]);
  await call("tools/call", {
    name: "ask_synchron_x",
    arguments: { question: "Continue", sessionId },
  }).expect(200);
  assert.equal(turns[1][0], sessionId);
  assert.deepEqual(reservations, [
    [member, 3, { provider: "openai", model: "test" }],
    [member, 3, { provider: "openai", model: "test" }],
  ]);

  const requests = [];
  const dom = new JSDOM(widget.body.result.contents[0].text, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.parent = {
        postMessage(message) {
          requests.push(message);
          if (message.id === undefined) return;
          const result =
            message.method === "ui/initialize"
              ? {}
              : message.params.name === "get_synchron_x_balance"
                ? { structuredContent: { remaining: 10 } }
                : {
                    structuredContent: {
                      answer: "Test reply.",
                      sessionId,
                      conversationPersisted: true,
                    },
                  };
          window.dispatchEvent(
            new window.MessageEvent("message", {
              source: window.parent,
              origin: "https://chatgpt.com",
              data: { jsonrpc: "2.0", id: message.id, result },
            }),
          );
        },
      };
    },
  });
  try {
    await new Promise(setImmediate);
    const { document, Event } = dom.window;
    assert.equal(document.getElementById("question").disabled, false);
    assert.match(document.getElementById("credit-label").textContent, /10/u);
    document.getElementById("question").value = "Try the workspace";
    document
      .getElementById("composer")
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise(setImmediate);
    assert.match(
      document.getElementById("messages").textContent,
      /Test reply/u,
    );
    assert.equal(
      requests.find((item) => item.params?.name === "ask_synchron_x").params
        .arguments.question,
      "Try the workspace",
    );
  } finally {
    dom.window.close();
  }
});
