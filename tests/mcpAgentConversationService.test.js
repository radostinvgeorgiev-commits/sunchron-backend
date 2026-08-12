import assert from "node:assert/strict";
import test from "node:test";

import {
  McpAgentConversationError,
  sendMcpAgentMessage,
} from "../src/services/mcpAgentConversationService.js";

function workspace(engine = "ai-core") {
  return {
    state: {
      activeProjectId: "project-1",
      activeAgentId: "agent-1",
      projects: [
        {
          id: "project-1",
          name: "Мост тест",
          objective: "Провери реален разговор",
          run: null,
        },
      ],
      agents: [
        {
          id: "agent-1",
          name: engine === "codex" ? "Codex" : "AI CORE",
          role: engine === "codex" ? "coder" : "builder",
          model: "auto",
          purpose: "Върни проверим отговор",
          engine,
          petId: "robot",
        },
      ],
    },
  };
}

test("MCP agent conversation reuses the owner workspace, memory and session", async () => {
  const calls = [];
  const result = await sendMcpAgentMessage(
    {
      ownerId: "primary-user",
      message: "Коя е следващата задача?",
      sessionId: "bridge-session-1",
      identity: { role: "owner", displayName: "Радко" },
    },
    {
      loadWorkspace: async (ownerId) => {
        calls.push(["workspace", ownerId]);
        return workspace();
      },
      listMemories: async (options) => {
        calls.push(["memory", options]);
        return [{ fact: "Проектът се казва AI CORE", scope: "project" }];
      },
      listMessages: async (...args) => {
        calls.push(["history", args]);
        return [{ role: "assistant", content: "Предишен отговор" }];
      },
      askAi: async ({ input, reasoningEffort, verbosity }) => {
        calls.push(["ai", input]);
        assert.equal(reasoningEffort, "low");
        assert.equal(verbosity, "medium");
        assert.match(input[0].content, /Мост тест/u);
        assert.match(input[0].content, /Предишен отговор/u);
        assert.match(input[0].content, /MCP МОСТ — САМО РАЗГОВОР/u);
        assert.match(input[0].content, /Не променяй код/u);
        return "Следващата задача е реален тест на моста.";
      },
      saveTurn: async (...args) => calls.push(["save", args]),
    },
  );

  assert.equal(result.sessionId, "bridge-session-1");
  assert.equal(result.agent.name, "AI CORE");
  assert.equal(result.project.name, "Мост тест");
  assert.equal(result.conversationPersisted, true);
  assert.equal(result.externalActionsExecuted, false);
  assert.equal(result.codeChanged, false);
  assert.deepEqual(calls[0], ["workspace", "primary-user"]);
  assert.deepEqual(calls[1], ["memory", { ownerId: "primary-user" }]);
  assert.deepEqual(calls[2], [
    "history",
    ["bridge-session-1", undefined, "primary-user"],
  ]);
  assert.deepEqual(calls.at(-1), [
    "save",
    [
      "bridge-session-1",
      "Коя е следващата задача?",
      "Следващата задача е реален тест на моста.",
      "primary-user",
    ],
  ]);
});

test("MCP agent conversation creates a new safe session when none is supplied", async () => {
  const result = await sendMcpAgentMessage(
    { ownerId: "member-1", message: "Здравей" },
    {
      loadWorkspace: async () => workspace(),
      listMemories: async () => [],
      listMessages: async () => [],
      askAi: async () => "Здравей.",
      saveTurn: async () => {},
      createSessionId: () => "mcp-fixed-session",
    },
  );
  assert.equal(result.sessionId, "mcp-fixed-session");
});

test("MCP agent conversation cannot silently route to Codex", async () => {
  await assert.rejects(
    sendMcpAgentMessage(
      { ownerId: "primary-user", message: "Промени кода" },
      { loadWorkspace: async () => workspace("codex") },
    ),
    (error) =>
      error instanceof McpAgentConversationError &&
      error.code === -32602 &&
      /само с AI CORE/u.test(error.message),
  );
});

test("MCP agent conversation rejects invalid identifiers before reading data", async () => {
  let workspaceReads = 0;
  await assert.rejects(
    sendMcpAgentMessage(
      {
        ownerId: "primary-user",
        message: "Тест",
        sessionId: "../../чужд-разговор",
      },
      {
        loadWorkspace: async () => {
          workspaceReads += 1;
          return workspace();
        },
      },
    ),
    (error) => error.code === -32602,
  );
  assert.equal(workspaceReads, 0);
});

test("MCP agent conversation stops after ten user questions in one session", async () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    role: "user",
    content: `Въпрос ${index + 1}`,
  }));
  let aiCalls = 0;
  let saveCalls = 0;

  await assert.rejects(
    () =>
      sendMcpAgentMessage(
        {
          ownerId: "primary-user",
          message: "Единадесети въпрос",
          sessionId: "bridge-session-limit",
        },
        {
          loadWorkspace: async () => workspace(),
          listMemories: async () => [],
          listMessages: async () => history,
          askAi: async () => {
            aiCalls += 1;
            return "Не трябва да се извика";
          },
          saveTurn: async () => {
            saveCalls += 1;
          },
        },
      ),
    (error) =>
      error instanceof McpAgentConversationError &&
      error.code === -32602 &&
      /лимита от 10 въпроса/u.test(error.message),
  );
  assert.equal(aiCalls, 0);
  assert.equal(saveCalls, 0);
});
