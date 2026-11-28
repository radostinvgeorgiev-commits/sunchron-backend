import assert from "node:assert/strict";
import test from "node:test";

import {
  McpAgentConversationError,
  sendMcpAgentMessage,
} from "../src/services/mcpAgentConversationService.js";

function workspace(engine = "novarium") {
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
          name: engine === "codex" ? "Codex" : "NovariumAI",
          role: engine === "codex" ? "coder" : "builder",
          model: "auto",
          purpose: "Върни проверим отговор",
          engine,
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
        return [{ fact: "Проектът се казва NovariumAI", scope: "project" }];
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
        assert.match(
          input[0].content,
          /MCP МОСТ — ПРОВЕРЕН ИНСТРУМЕНТАЛЕН РЕЖИМ/u,
        );
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
  assert.equal(result.agent.name, "NovariumAI");
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
          {
            capability: "code.write",
            action: "github.write",
            message: "Създай Pull Request",
          },
        ],
        results: [
          {
            status: "fulfilled",
            request: { capability: "code.write", action: "github.write" },
            result: {
              output:
                "GitHub промяната е подготвена. Потвърждение: confirmation-1.",
              permission: { decision: "confirm" },
              tool: { name: "NovariumAI Code Write" },
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
      /само с NovariumAI/u.test(error.message),
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

// Item 3, fix 3: „какво ми е деня днес“ names no Google service, but it reads
// the calendar, so the person's Google connection is opened for it.
test("MCP agent conversation opens Google for the person's day in their own words", async () => {
  let taskOptions;
  const result = await sendMcpAgentMessage(
    {
      ownerId: "primary-user",
      message: "какво ми е деня днес",
      identity: { role: "owner", displayName: "Радко" },
    },
    {
      loadWorkspace: async () => workspace(),
      listMemories: async () => [],
      listMessages: async () => [],
      readWords: async () => ({ type: "none" }),
      getGoogleSession: async () => "google-session",
      runTask: async (options) => {
        taskOptions = options;
        const request = options.fallbackRequests[0];
        return {
          requests: options.fallbackRequests,
          results: [
            {
              status: "fulfilled",
              request,
              result: { output: "Предстоящи събития:\n• Среща с Иван — 2026-11-28T10:00", requiresConfirmation: false },
            },
          ],
          task: { id: "task-day", status: "completed", verified: true },
          plannerUsed: false,
        };
      },
      saveTurn: async () => {},
    },
  );
  assert.deepEqual(
    taskOptions.fallbackRequests.map(({ capability }) => capability),
    ["calendar.read"],
  );
  assert.equal(taskOptions.executionContext.googleSessionId, "google-session");
  assert.match(result.response, /Среща с Иван/u);
});

// Item 3, fix 4: „Моите задачи“ through the connector, in the person's words.
test("MCP agent conversation reads and adds to the person's own list in their words", async () => {
  const seen = [];
  let googleOpened = 0;
  for (const message of ["добави задача да се обадя на банката утре", "кви задачи имам отворени"]) {
    const result = await sendMcpAgentMessage(
      { ownerId: "primary-user", message, identity: { role: "owner", displayName: "Радко" } },
      {
        loadWorkspace: async () => workspace(),
        listMemories: async () => [],
        listMessages: async () => [],
        readWords: async () => ({ type: "none" }),
        getGoogleSession: async () => {
          googleOpened += 1;
          return "google-session";
        },
        runTask: async (options) => {
          seen.push(options.fallbackRequests.map(({ capability, input }) => [capability, input?.text || ""]));
          const request = options.fallbackRequests[0];
          return {
            requests: options.fallbackRequests,
            results: [
              {
                status: "fulfilled",
                request,
                result: { output: "Добавих в „Моите задачи“: Да се обадя на банката (утре).", requiresConfirmation: false },
              },
            ],
            task: { id: "task-todo", status: "completed", verified: true },
            plannerUsed: false,
          };
        },
        saveTurn: async () => {},
      },
    );
    assert.match(result.response, /Моите задачи/u);
  }
  assert.deepEqual(seen, [[["todos.add", "Да се обадя на банката"]], [["todos.read", ""]]]);
  // The person's own list needs no Google connection.
  assert.equal(googleOpened, 0);
});

// Item 3 (Team 2's probes 12 to 14 got ASCII art, SVG code or only a prompt):
// a picture is drawn and comes back with the answer.
test("MCP agent conversation draws the picture the person asks for", async () => {
  const drawn = [];
  const saved = [];
  const base = {
    loadWorkspace: async () => workspace(),
    listMemories: async () => [],
    listMessages: async () => [],
    readWords: async () => ({ type: "media", items: [{ kind: "image", prompt: "Рижа котка на прозорец, акварел" }] }),
    runTask: async () => {
      throw new Error("a picture runs no task");
    },
    askAi: async () => {
      throw new Error("a picture needs no model answer");
    },
    saveTurn: async (...args) => saved.push(args),
  };
  const result = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "нарисувай ми котка", identity: { role: "owner", displayName: "Радко" } },
    {
      ...base,
      drawImage: async (prompt) => {
        drawn.push(prompt);
        return { image: "data:image/webp;base64,UklGRg==", prompt, model: "image-model" };
      },
    },
  );
  assert.deepEqual(drawn, ["Рижа котка на прозорец, акварел"]);
  assert.equal(result.response, "Нарисувах картинката: Рижа котка на прозорец, акварел");
  assert.deepEqual(result.image, { mimeType: "image/webp", data: "UklGRg==" });
  assert.deepEqual(result.capabilities, ["image.generate"]);
  assert.equal(saved[0][2], result.response);

  // A refusal is said as it is; nothing is pretended.
  const { ImageGenerationError } = await import("../src/services/imageGenerationService.js");
  const failed = await sendMcpAgentMessage(
    { ownerId: "primary-user", message: "нарисувай ми котка", identity: { role: "owner", displayName: "Радко" } },
    {
      ...base,
      drawImage: async () => {
        throw new ImageGenerationError("Няма настроен инструмент за картинки.");
      },
    },
  );
  assert.equal(failed.response, "Картинката не стана: Няма настроен инструмент за картинки.");
  assert.equal("image" in failed, false);
  assert.deepEqual(failed.capabilities, []);
});

// The open tree (MANIFESTO §8): a member's own branch has their own Google,
// never the owner's.
test("MCP agent conversation reads a member's own Google, never the owner's", async () => {
  const ana = { role: "member", displayName: "Ана", memoryOwnerId: "identity-platform:ana" };
  let ownerGoogle = 0;
  const seen = [];
  for (const own of ["ana-google", null]) {
    await sendMcpAgentMessage(
      { ownerId: ana.memoryOwnerId, message: "каво имам в пошата", identity: ana },
      {
        loadWorkspace: async () => workspace(),
        listMemories: async () => [],
        listMessages: async () => [],
        readWords: async () => ({
          type: "requests",
          requests: [{ capability: "mail.read", action: "mail.read", message: "каво имам в пошата" }],
        }),
        getGoogleSession: async () => {
          ownerGoogle += 1;
          return "owner-google";
        },
        getOwnGoogleSession: async (identity) => {
          assert.equal(identity.memoryOwnerId, ana.memoryOwnerId);
          return own;
        },
        runTask: async (options) => {
          seen.push([options.fallbackRequests.map(({ capability }) => capability), options.executionContext.googleSessionId]);
          return {
            requests: options.fallbackRequests,
            results: [],
            task: { id: "task-mail", status: "completed", verified: true },
            plannerUsed: false,
          };
        },
        askAi: async () => "Готово.",
        saveTurn: async () => {},
      },
    );
  }
  assert.deepEqual(seen, [
    [["mail.read"], "ana-google"],
    [[], null],
  ]);
  assert.equal(ownerGoogle, 0);
});
