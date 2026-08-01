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

  assert.equal(state.version, 2);
  assert.equal(state.mode, "chat");
  assert.equal(state.petId, "robot");
  assert.equal(state.projects.length, 20);
  assert.equal(state.projects[0].id, "project-0");
  assert.equal(state.projects[0].status, "ready");
  assert.doesNotMatch(state.projects[0].name, /\u0000/u);
  assert.equal(state.agents[0].role, "general");
  assert.equal(state.agents[0].model, "auto");
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
      projects: [{ id: "p1", name: "Сайт", status: "running" }],
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
  assert.doesNotMatch(JSON.stringify(indexed.body), /primary-user/u);
  assert.equal(result.state.mode, "work");
  assert.equal(result.state.agents[0].model, "gpt-5.6-terra");
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
  assert.equal(result.state.agents[0].name, "AI CORE");
});
