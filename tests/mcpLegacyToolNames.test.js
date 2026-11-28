import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  createChatGptMcpRouter,
  LEGACY_CHATGPT_TOOL_NAMES,
} from "../src/routes/chatGptMcpRouter.js";
import mcpRouter, {
  LEGACY_MCP_TOOL_NAMES,
  renameLegacyMcpTools,
} from "../src/routes/mcpRouter.js";
import { createPublicAiBudgetContext } from "../src/services/publicAiBudget.js";

const toolCall = (name, args = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

test("only a tool call with an old name gets the new name", () => {
  const rename = renameLegacyMcpTools(LEGACY_MCP_TOOL_NAMES);
  const pass = (body) => {
    let called = false;
    rename({ body }, {}, () => {
      called = true;
    });
    assert.equal(called, true);
    return body;
  };
  assert.equal(
    pass(toolCall("run_ai_core_self_test")).params.name,
    "run_novarium_self_test",
  );
  assert.equal(
    pass(toolCall("talk_to_ai_core")).params.name,
    "talk_to_novarium",
  );
  for (const name of ["run_novarium_self_test", "toString", "__proto__"]) {
    assert.equal(pass(toolCall(name)).params.name, name);
  }
  assert.equal(
    pass({ ...toolCall("talk_to_ai_core"), method: "prompts/get" }).params.name,
    "talk_to_ai_core",
  );
  for (const body of [undefined, {}, { method: "tools/call", params: "x" }]) {
    pass(body);
  }
});

test("an old Claude tool name asks for the same access as the new one and is not listed", async () => {
  const app = express().use(express.json()).use("/mcp", mcpRouter);
  const challenge = async (name) =>
    (await request(app).post("/mcp").send(toolCall(name)).expect(401))
      .headers["www-authenticate"];
  for (const [oldName, newName] of Object.entries(LEGACY_MCP_TOOL_NAMES)) {
    assert.equal(await challenge(oldName), await challenge(newName));
  }
  assert.match(await challenge("talk_to_ai_core"), /synchron:agent\.chat/u);

  const listed = await request(app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    .expect(200);
  const names = listed.body.result.tools.map((tool) => tool.name);
  for (const [oldName, newName] of Object.entries(LEGACY_MCP_TOOL_NAMES)) {
    assert.ok(names.includes(newName));
    assert.ok(!names.includes(oldName));
  }
});

test("the ChatGPT app with the old tool list still opens, answers and shows the balance", async () => {
  const member = {
    id: "member",
    memoryOwnerId: "identity-platform:member",
    role: "member",
  };
  const turns = [];
  const app = express()
    .use(express.json())
    .use(
      "/mcp/chatgpt",
      createChatGptMcpRouter({
        verify: (authorization) => (authorization ? member : null),
        assertGrant: async () => {},
        getUsage: async () => ({ remaining: 7 }),
        budget: createPublicAiBudgetContext({ reserve: async () => {} }),
        listMessages: async () => [],
        saveTurn: async (...args) => turns.push(args),
        ask: async () => "Answer for the old app.",
      }),
    );
  const call = (body, auth = true) => {
    const req = request(app).post("/mcp/chatgpt").send(body);
    return auth ? req.set("Authorization", "Bearer mock") : req;
  };

  const listed = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "open_novarium_workspace",
    "ask_novarium",
    "get_novarium_balance",
  ]);
  for (const [oldName, newName] of Object.entries(LEGACY_CHATGPT_TOOL_NAMES)) {
    assert.ok(names.includes(newName));
    assert.ok(!names.includes(oldName));
  }

  const oldUri = "ui://synchron-x/workspace-v1.html";
  const widget = await call(
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: oldUri } },
    false,
  ).expect(200);
  assert.equal(widget.body.result.contents[0].uri, oldUri);
  assert.match(widget.body.result.contents[0].text, /id="composer"/u);
  const unknown = await call(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "ui://synchron-x/other.html" },
    },
    false,
  ).expect(200);
  assert.equal(unknown.body.error.code, -32002);

  await call(toolCall("get_synchron_x_balance"), false)
    .expect(401)
    .expect("WWW-Authenticate", /oauth-protected-resource\/mcp\/chatgpt/u);
  const opened = await call(toolCall("open_synchron_x_workspace")).expect(200);
  assert.equal(opened.body.result.content[0].text, "NovariumAI is open.");
  const balance = await call(toolCall("get_synchron_x_balance")).expect(200);
  assert.equal(balance.body.result.structuredContent.remaining, 7);
  const answer = await call(
    toolCall("ask_synchron_x", { question: "Hello" }),
  ).expect(200);
  assert.equal(
    answer.body.result.structuredContent.answer,
    "Answer for the old app.",
  );
  assert.equal(turns.length, 1);
});
