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
        assert.match(input[0].content, /MCP МОСТ — ПРОВЕРЕН ИНСТРУМЕНТАЛЕН РЕЖИМ/u);
        assert.match(input[0].content, /Не изпълнявай shell команди/u);
        assert.deepEqual(
          input.slice(-2).map(({ role, content }) => ({ role, content })),
          [
            { role: "assistant", content: "Предишен отговор" },
            { role: "user", content: "Коя е следващата задача?" },
          ],
        );
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

test("MCP agent conversation executes a detected read-only capability", async () => {
  let taskOptions;
  const result = await sendMcpAgentMessage(
    {
      ownerId: "primary-user",
      message: "Провери състоянието на бекенда",
      identity: { role: "owner", displayName: "Радко" },
    },
    {
      loadWorkspace: async () => workspace(),
      listMemories: async () => [],
      listMessages: async () => [],
      runTask: async (options) => {
        taskOptions = options;
        return {
          requests: [
            {
              capability: "infrastructure.googlecloud.diagnostics.read",
              action: "infrastructure.read",
              message: "Провери състоянието на бекенда",
            },
          ],
          results: [
            {
              status: "fulfilled",
              request: {
                capability: "infrastructure.googlecloud.diagnostics.read",
                action: "infrastructure.read",
              },
              result: {
                output: "Project diagnostics: PASS.",
                permission: { decision: "allow" },
                tool: { name: "Google Cloud Project Diagnostics" },
                requiresConfirmation: false,
              },
            },
          ],
          task: {
            id: "task-1",
            status: "completed",
            verified: true,
          },
          plannerUsed: false,
        };
      },
      saveTurn: async () => {},
    },
  );

  assert.equal(result.response, "Project diagnostics: PASS.");
  assert.deepEqual(result.capabilities, [
    "infrastructure.googlecloud.diagnostics.read",
  ]);
  assert.equal(result.task.status, "completed");
  assert.equal(taskOptions.executionContext.prepareConfirmation, true);
  assert.equal(taskOptions.executionContext.ownerId, "primary-user");
  assert.equal(result.externalActionsExecuted, false);
});

test("MCP agent conversation returns owner confirmation for a write capability", async () => {
  const result = await sendMcpAgentMessage(
    {
      ownerId: "primary-user",
      message: "Създай Pull Request в GitHub",
      identity: { role: "owner", displayName: "Радко" },
    },
    {
      loadWorkspace: async () => workspace(),
      listMemories: async () => [],
      listMessages: async () => [],
      runTask: async () => ({
        requests: [
          { capability: "code.write", action: "github.write", message: "Създай Pull Request" },
        ],
        results: [
          {
            status: "fulfilled",
            request: { capability: "code.write", action: "github.write" },
            result: {
              output: "GitHub промяната е подготвена. Потвърждение: confirmation-1.",
              permission: { decision: "confirm" },
              tool: { name: "AI CORE Code Write" },
              requiresConfirmation: true,
            },
          },
        ],
        task: { id: "task-2", status: "waiting_confirmation", verified: false },
      }),
      saveTurn: async () => {},
    },
  );

  assert.match(result.response, /confirmation-1/u);
  assert.equal(result.task.status, "waiting_confirmation");
  assert.equal(result.externalActionsExecuted, false);
  assert.equal(result.codeChanged, false);
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
