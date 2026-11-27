import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createClaudeWorkRouter } from "../src/routes/claudeWorkRouter.js";
import {
  buildClaudeWorkRequest,
  collectFileIds,
  createClaudeWorkService,
} from "../src/services/claudeWorkService.js";

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(collection, id) {
      const data = rows.get(`${collection}/${id}`);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async commitOperations(operations) {
      for (const { type, collection, id, data } of operations) {
        if (type === "delete") rows.delete(`${collection}/${id}`);
        else rows.set(`${collection}/${id}`, structuredClone(data));
      }
    },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake Anthropic API: the first turn pauses, the second finishes with a file.
function fakeApi(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/messages")) {
      const turn = calls.filter((call) => call.url.endsWith("/messages")).length;
      if (turn === 1) {
        return json({
          model: "claude-haiku-5-5",
          container: { id: "container-1" },
          stop_reason: "pause_turn",
          content: [{ type: "text", text: "Започвам. " }, { type: "server_tool_use", id: "t1", name: "bash_code_execution", input: {} }],
        });
      }
      return json({
        model: "claude-haiku-5-5",
        container: { id: "container-1" },
        stop_reason: "end_turn",
        content: [
          {
            type: "bash_code_execution_tool_result",
            tool_use_id: "t1",
            content: { type: "bash_code_execution_result", stdout: "", stderr: "", return_code: 0, content: [{ type: "bash_code_execution_output", file_id: "file_abc" }] },
          },
          { type: "text", text: "Готово: презентацията е в reklama.pptx." },
        ],
      });
    }
    if (String(url).endsWith("/files/file_abc")) {
      return json({ id: "file_abc", filename: "/tmp/outputs/reklama.pptx", mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size_bytes: 5 });
    }
    if (String(url).endsWith("/files/file_abc/content")) return new Response("PPTX!", { status: 200 });
    return json({}, 404);
  };
}

test("the request asks for Anthropic's skills, code execution and, if wanted, web search", () => {
  const body = buildClaudeWorkRequest({ model: "m", task: "x", skills: ["pptx", "evil", "pdf"], webSearch: true, instructions: "Пиши кратко." });
  assert.deepEqual(body.container.skills, [
    { type: "anthropic", skill_id: "pptx", version: "latest" },
    { type: "anthropic", skill_id: "pdf", version: "latest" },
  ]);
  assert.deepEqual(body.tools.map((tool) => tool.type), ["code_execution_20260521", "web_search_20250305"]);
  assert.match(body.system, /\$OUTPUT_DIR/u);
  assert.match(body.system, /Пиши кратко\./u);
  const plain = buildClaudeWorkRequest({ model: "m", task: "x" });
  assert.equal(plain.container, undefined);
  assert.equal(plain.tools.length, 1);
});

test("file ids are found anywhere in the answer", () => {
  assert.deepEqual(collectFileIds([{ a: [{ file_id: "f1" }, { b: { file_id: "f2" } }] }, { file_id: "f1" }]), ["f1", "f2"]);
});

test("a task goes on after a pause, keeps the container, and only its owner can download the file", async () => {
  const calls = [];
  const service = createClaudeWorkService({
    store: memoryStore(),
    env: { ANTHROPIC_API_KEY: "test-key" },
    fetchImpl: fakeApi(calls),
    now: () => 1000,
  });
  const result = await service.run("owner-1", { task: "Направи презентация за Novarium", skills: ["pptx"] });
  assert.equal(result.text, "Започвам. Готово: презентацията е в reklama.pptx.");
  assert.deepEqual(result.files, [
    { id: "file_abc", name: "reklama.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 5 },
  ]);
  const turns = calls.filter((call) => call.url.endsWith("/messages"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].headers["anthropic-beta"], "code-execution-2025-08-25");
  assert.equal(turns[0].body.model, "claude-haiku-5-5");
  assert.equal(turns[1].body.container.id, "container-1");
  assert.equal(turns[1].body.messages.at(-1).role, "assistant");

  const file = await service.download("owner-1", "file_abc");
  assert.equal(file.body.toString(), "PPTX!");
  assert.equal(file.name, "reklama.pptx");
  await assert.rejects(service.download("someone-else", "file_abc"), { code: "CLAUDE_WORK_FILE_NOT_FOUND" });
  assert.deepEqual((await service.listFiles("owner-1")).map((row) => row.id), ["file_abc"]);

  await service.clear("owner-1");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/files/file_abc")));
  assert.deepEqual(await service.listFiles("owner-1"), []);
});

test("an empty task and a missing key are clear errors", async () => {
  const service = createClaudeWorkService({ store: memoryStore(), env: {}, fetchImpl: async () => json({}) });
  await assert.rejects(service.run("o", { task: "  " }), { code: "CLAUDE_WORK_INVALID" });
  await assert.rejects(service.run("o", { task: "x" }), { code: "CLAUDE_NOT_CONFIGURED" });
});

test("units come back when the task fails, and the file is sent as a download", async () => {
  const refunds = [];
  const service = {
    skills: () => [],
    listFiles: async () => [],
    run: async (_owner, body) => {
      if (body.task === "fail") throw new Error("boom");
      return { text: "ok", files: [] };
    },
    download: async () => ({ name: "отчет.pdf", mimeType: "application/pdf", body: Buffer.from("%PDF") }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => ((req.owner = { memoryOwnerId: "o1", role: "member" }), next()));
  app.use("/api/claude-work", createClaudeWorkRouter({ service, reserve: async () => async () => refunds.push(1) }));
  assert.equal((await request(app).post("/api/claude-work").send({ task: "ok" })).body.text, "ok");
  assert.equal(refunds.length, 0);
  const failed = await request(app).post("/api/claude-work").send({ task: "fail" });
  assert.equal(failed.status, 503);
  assert.equal(refunds.length, 1);
  const file = await request(app).get("/api/claude-work/files/f1");
  assert.equal(file.headers["content-type"], "application/pdf");
  assert.match(file.headers["content-disposition"], /filename\*=UTF-8''%D0%BE%D1%82%D1%87%D0%B5%D1%82\.pdf/u);
});

test("the stronger Claude models cost more units and answer with low effort in chat", async () => {
  const { creditsForChatModel, requestClaudeResponse } = await import("../src/services/aiCoreService.js");
  assert.equal(creditsForChatModel("claude-haiku-5-5"), 1);
  assert.equal(creditsForChatModel("claude-sonnet-5-5"), 4);
  assert.equal(creditsForChatModel("claude-opus-5-5"), 8);
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ model: "m", content: [{ type: "text", text: "ok" }], usage: {} });
  };
  const input = [{ role: "user", content: "здравей" }];
  await requestClaudeResponse({ apiKey: "k", input, model: "claude-opus-5-5", fetchImpl });
  await requestClaudeResponse({ apiKey: "k", input, model: "claude-haiku-5-5", fetchImpl });
  assert.deepEqual(bodies[0].output_config, { effort: "low" });
  assert.equal(bodies[1].output_config, undefined);
});

test("connectors go to Anthropic as MCP servers with the MCP beta; skills become instructions", async () => {
  const { claudeWorkBetas, skillInstructions } = await import("../src/services/claudeWorkService.js");
  const body = buildClaudeWorkRequest({
    model: "m",
    task: "x",
    connectors: [{ name: "Времето", url: "https://mcp.example.com/mcp" }],
  });
  assert.deepEqual(body.mcp_servers, [{ type: "url", url: "https://mcp.example.com/mcp", name: "connector-1" }]);
  assert.deepEqual(body.tools.at(-1), { type: "mcp_toolset", mcp_server_name: "connector-1" });
  assert.equal(claudeWorkBetas(body), "code-execution-2025-08-25,mcp-client-2025-11-20");
  assert.equal(claudeWorkBetas(buildClaudeWorkRequest({ model: "m", task: "x" })), "code-execution-2025-08-25");
  assert.equal(skillInstructions([{ name: "Стил", instructions: "Пиши весело." }]), "## Стил\nПиши весело.");
});

test("skills and connectors are add-ons: checked, reviewed as a whole, and picked for Claude", async () => {
  const { createAddonService } = await import("../src/services/addonService.js");
  let id = 0;
  const addons = createAddonService({ store: memoryStore(), createId: () => `a${++id}` });
  await assert.rejects(addons.save("me", { kind: "skill", name: "Празно" }), /Напиши какво да прави Claude/u);
  await assert.rejects(addons.save("me", { kind: "connector", name: "Вътрешен", mcpUrl: "https://localhost/mcp" }), /публичен/u);
  await assert.rejects(addons.save("me", { kind: "connector", name: "Без https", mcpUrl: "http://example.com/mcp" }), /https/u);
  const { item: skill } = await addons.save("me", { kind: "skill", name: "Реклами", instructions: "Пиши кратки реклами." });
  const { item: connector } = await addons.save("me", { kind: "connector", name: "Данни", mcpUrl: "https://mcp.example.com/mcp" });
  assert.equal((await addons.runMine("me", skill.id, "")).ok, false);

  await addons.submit("me", skill.id);
  assert.equal((await addons.listPending())[0].instructions, "Пиши кратки реклами.");
  await addons.approve(skill.id);
  const store = await addons.listPublic();
  assert.equal(store[0].kind, "skill");

  // Another person sees the approved skill, but not my private connector.
  assert.deepEqual((await addons.claudeChoices("other")).map((row) => row.id), [skill.id]);
  const picked = await addons.forClaude("other", [skill.id, connector.id, "missing"]);
  assert.deepEqual(picked, { skills: [{ name: "Реклами", instructions: "Пиши кратки реклами." }], connectors: [] });
  const mine = await addons.forClaude("me", [connector.id]);
  assert.deepEqual(mine.connectors, [{ name: "Данни", url: "https://mcp.example.com/mcp" }]);
});

test("the router hands the chosen add-ons to Claude", async () => {
  const seen = [];
  const service = {
    skills: () => [],
    listFiles: async () => [],
    run: async (_owner, body) => (seen.push(body), { text: "ok", files: [] }),
  };
  const addons = {
    claudeChoices: async () => [{ id: "s1", kind: "skill", name: "Реклами" }],
    forClaude: async (_owner, ids) => ({
      skills: ids.includes("s1") ? [{ name: "Реклами", instructions: "Кратко." }] : [],
      connectors: [{ name: "Данни", url: "https://mcp.example.com/mcp" }],
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => ((req.owner = { memoryOwnerId: "o1", role: "owner" }), next()));
  app.use("/api/claude-work", createClaudeWorkRouter({ service, addons, reserve: async () => async () => false }));
  assert.equal((await request(app).get("/api/claude-work")).body.addons[0].id, "s1");
  await request(app).post("/api/claude-work").send({ task: "Реклама", addons: ["s1"] });
  assert.equal(seen[0].instructions, "## Реклами\nКратко.");
  assert.deepEqual(seen[0].connectors, [{ name: "Данни", url: "https://mcp.example.com/mcp" }]);
});
