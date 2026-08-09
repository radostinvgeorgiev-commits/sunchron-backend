import assert from "node:assert/strict";
import test from "node:test";

import {
  loadWorkspaceState,
  normalizeWorkspaceState,
  saveWorkspaceState,
  workspaceDocumentId,
} from "../src/services/workspaceStateService.js";

test("workspace state is bounded and strips untrusted values", () => {
  const state = normalizeWorkspaceState(
    {
      mode: "admin",
      petId: "dragon",
      activeProjectId: "unsafe",
      projects: Array.from({ length: 25 }, (_, index) => ({
        id: `project ${index}`,
        name: `\u0000Проект ${index}`,
        objective: "Цел",
        status: "deleted",
        decisions: ["Използваме потвърждение", { text: "Само HTTPS" }],
        resources: [
          { label: "Документ", url: "https://example.com/plan" },
          { label: "Опасен", url: "javascript:alert(1)" },
        ],
        toolIds: ["github-read", "../../unsafe"],
        conversationIds: ["thread-1", "invalid id"],
        run:
          index === 0
            ? {
                sequence: 2,
                status: "ready_for_next_step",
                summary: "Проверен резултат",
                evidence: ["src/index.js"],
                nextStep: "Добави тест",
                needsUserDecision: true,
                codeChanged: true,
              }
            : null,
      })),
      agents: [
        {
          id: "agent one",
          name: "Моят агент",
          role: "system-admin",
          model: "made-up-model",
          purpose: "Работи спокойно",
        },
      ],
      activities: Array.from({ length: 45 }, (_, index) => ({
        taskId: `task ${index}`,
        status: "completed",
        message: "Готово",
      })),
    },
    { now: "2026-08-01T10:00:00.000Z" },
  );

  assert.equal(state.version, 6);
  assert.equal(state.mode, "chat");
  assert.equal(state.petId, "robot");
  assert.equal(state.projects.length, 20);
  assert.equal(state.projects[0].id, "project-0");
  assert.equal(state.projects[0].status, "ready");
  assert.doesNotMatch(state.projects[0].name, /\u0000/u);
  assert.equal(state.projects[0].run.sequence, 2);
  assert.equal(state.projects[0].run.codeChanged, false);
  assert.equal(state.projects[0].run.needsUserDecision, true);
  assert.deepEqual(
    state.projects[0].decisions.map((item) => item.text),
    ["Използваме потвърждение", "Само HTTPS"],
  );
  assert.deepEqual(state.projects[0].resources, [
    {
      label: "Документ",
      url: "https://example.com/plan",
      type: "link",
    },
  ]);
  assert.deepEqual(state.projects[0].toolIds, ["github-read"]);
  assert.deepEqual(state.projects[0].conversationIds, ["thread-1"]);
  assert.equal(state.agents[0].role, "general");
  assert.equal(state.agents[0].model, "auto");
  assert.equal(state.agents[0].engine, "ai-core");
  assert.ok(state.agents.some((agent) => agent.engine === "codex"));
  assert.ok(state.agents.some((agent) => agent.role === "researcher"));
  assert.ok(state.agents.some((agent) => agent.role === "organizer"));
  assert.ok(state.agents.some((agent) => agent.role === "documents"));
  assert.equal(state.activities.length, 40);
});

test("workspace document id is stable and does not expose the owner id", () => {
  const first = workspaceDocumentId("supabase:user-123");
  const second = workspaceDocumentId("supabase:user-123");
  const other = workspaceDocumentId("supabase:user-456");

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(first.length, 64);
  assert.doesNotMatch(first, /user-123/u);
});

test("workspace keeps a supported personal pet", () => {
  const state = normalizeWorkspaceState({ petId: "drop" });

  assert.equal(state.petId, "drop");
});


test("workspace preserves every explicitly supported AI provider model", () => {
  for (const model of [
    "gemini-2.5-flash",
    "grok-3-mini",
    "claude-sonnet-5",
  ]) {
    const state = normalizeWorkspaceState({
      agents: [
        {
          id: `agent-${model}`,
          name: model,
          role: "general",
          model,
          engine: "ai-core",
        },
      ],
    });
    assert.equal(state.agents[0].model, model);
  }
});

test("legacy workspaces receive specialized agents with their own pets", () => {
  const state = normalizeWorkspaceState({
    version: 4,
    activeAgentId: "synchron-builder",
    petId: "drop",
    agents: [
      {
        id: "synchron-builder",
        name: "AI CORE",
        role: "builder",
        engine: "ai-core",
      },
      {
        id: "codex-agent",
        name: "Codex",
        role: "coder",
        engine: "codex",
      },
    ],
  });

  assert.equal(state.version, 6);
  assert.equal(
    state.agents.find((agent) => agent.id === "synchron-builder").petId,
    "drop",
  );
  assert.equal(
    state.agents.find((agent) => agent.id === "codex-agent").petId,
    "spark",
  );
  assert.equal(
    state.agents.find((agent) => agent.id === "research-agent").petId,
    "owl",
  );
  assert.equal(
    state.agents.find((agent) => agent.id === "organizer-agent").petId,
    "rock",
  );
  assert.equal(
    state.agents.find((agent) => agent.id === "documents-agent").petId,
    "cat",
  );
});

test("workspace state is saved in an isolated hashed document", async () => {
  let indexed = null;
  const client = {
    async index(input) {
      indexed = input;
      return { body: { result: "created" } };
    },
  };
  const result = await saveWorkspaceState(
    "primary-user",
    {
      mode: "work",
      activeProjectId: "p1",
      activeAgentId: "a1",
      projects: [
        {
          id: "p1",
          name: "Сайт",
          status: "running",
          run: {
            sequence: 1,
            status: "ready_for_next_step",
            summary: "Проверено",
            nextStep: "Продължи",
          },
        },
      ],
      agents: [
        {
          id: "a1",
          name: "Строител",
          role: "builder",
          model: "gpt-5.6-terra",
        },
      ],
    },
    { client, now: "2026-08-01T11:00:00.000Z" },
  );

  assert.equal(indexed.index, "synchron-workspaces-v1");
  assert.equal(indexed.id, workspaceDocumentId("primary-user"));
  assert.equal(indexed.body.ownerHash, indexed.id);
  assert.equal(indexed.body.schemaVersion, 2);
  assert.doesNotMatch(JSON.stringify(indexed.body), /primary-user/u);
  assert.equal(result.state.mode, "work");
  assert.equal(result.state.agents[0].model, "gpt-5.6-terra");
  assert.ok(result.state.agents.some((agent) => agent.engine === "codex"));
  assert.equal(result.state.projects[0].run.nextStep, "Продължи");
  assert.equal(result.persisted, true);
});

test("missing workspace returns a safe starter state", async () => {
  const client = {
    async get() {
      const error = new Error("not found");
      error.meta = { statusCode: 404 };
      throw error;
    },
  };
  const result = await loadWorkspaceState("primary-user", { client });

  assert.equal(result.persisted, false);
  assert.equal(result.state.projects[0].id, "starter-project");
  assert.equal(result.state.agents[0].name, "Изпълни");
  assert.deepEqual(
    result.state.agents.map((agent) => agent.name),
    ["Изпълни", "Проучи", "Организирай", "Напиши", "Код"],
  );
});
