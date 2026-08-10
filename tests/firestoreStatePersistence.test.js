import assert from "node:assert/strict";
import test from "node:test";

import {
  addTaskNote,
  confirmTaskStatusChange,
  createTaskDraft,
  linkTaskToProject,
  listTasks,
  prepareTaskStatusChange,
  setFirestoreTaskStoreForTests,
} from "../src/services/taskManagementService.js";
import {
  loadWorkspaceState,
  saveWorkspaceState,
  setFirestoreWorkspaceStoreForTests,
  workspaceDocumentId,
} from "../src/services/workspaceStateService.js";
import { getToolRuntimeAvailability } from "../src/tools/capabilityEngine.js";

const ENV = Object.freeze({
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
});

function documentStoreDouble() {
  const records = new Map();
  return {
    records,
    async get(id) {
      const data = records.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async set(id, data) {
      records.set(id, structuredClone(data));
    },
    async listByOwner(ownerHash, limit = 1_000) {
      return [...records.entries()]
        .filter(([, data]) => data.ownerHash === ownerHash)
        .slice(0, limit)
        .map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
  };
}

test.afterEach(() => {
  setFirestoreWorkspaceStoreForTests(null);
  setFirestoreTaskStoreForTests(null);
});

test("Firestore saves and loads an owner-isolated workspace without OpenSearch", async () => {
  const store = documentStoreDouble();
  setFirestoreWorkspaceStoreForTests(store);

  const saved = await saveWorkspaceState(
    "identity-platform:user-a",
    {
      mode: "work",
      activeProjectId: "project-a",
      projects: [{ id: "project-a", name: "GCP migration" }],
    },
    { env: ENV, now: "2026-08-10T01:00:00.000Z" },
  );
  const id = workspaceDocumentId("identity-platform:user-a");
  const loaded = await loadWorkspaceState("identity-platform:user-a", {
    env: ENV,
  });

  assert.equal(saved.persisted, true);
  assert.equal(loaded.persisted, true);
  assert.equal(loaded.state.projects[0].id, "project-a");
  assert.ok(store.records.has(id));
  assert.equal(store.records.get(id).ownerHash, id);
  assert.doesNotMatch(
    JSON.stringify([...store.records.values()]),
    /identity-platform:user-a/u,
  );
});

test("Firestore tasks preserve owner isolation, notes, project links and confirmed status", async () => {
  const store = documentStoreDouble();
  setFirestoreTaskStoreForTests(store);
  const ownerId = "identity-platform:user-a";
  const task = await createTaskDraft(
    { ownerId, title: "Провери Firestore state" },
    {
      env: ENV,
      createId: () => "11111111-1111-4111-8111-111111111111",
      now: () => "2026-08-10T01:10:00.000Z",
    },
  );
  const noted = await addTaskNote(
    { ownerId, taskId: task.id, note: "Owner isolation е зелено." },
    { env: ENV, now: () => "2026-08-10T01:11:00.000Z" },
  );
  const linked = await linkTaskToProject(
    { ownerId, taskId: task.id, projectId: "project-a" },
    {
      env: ENV,
      now: () => "2026-08-10T01:12:00.000Z",
      loadWorkspace: async () => ({
        state: { projects: [{ id: "project-a" }] },
      }),
    },
  );
  let confirmation;
  await prepareTaskStatusChange(
    {
      ownerId,
      sessionId: "session-a",
      taskId: task.id,
      status: "completed",
    },
    {
      env: ENV,
      createConfirmation: async (input) => {
        confirmation = {
          id: "confirmation-a",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return confirmation;
      },
    },
  );
  const completed = await confirmTaskStatusChange(
    {
      ownerId,
      sessionId: "session-a",
      confirmationId: confirmation.id,
    },
    {
      env: ENV,
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => true,
      executeWrite: async ({ execute }) => execute(),
      now: () => "2026-08-10T01:13:00.000Z",
    },
  );

  assert.equal(noted.notes.at(-1).text, "Owner isolation е зелено.");
  assert.equal(linked.projectId, "project-a");
  assert.equal(completed.status, "completed");
  assert.equal(
    (await listTasks({ ownerId, status: "completed" }, { env: ENV })).length,
    1,
  );
  assert.equal(
    (await listTasks({ ownerId: "identity-platform:user-b" }, { env: ENV }))
      .length,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify([...store.records.values()]),
    /identity-platform:user-a/u,
  );
});

test("task capability accepts Firestore and still requires an authenticated owner", () => {
  assert.equal(
    getToolRuntimeAvailability("synchron-tasks", { ownerId: "owner-a" }, ENV)
      .available,
    true,
  );
  assert.equal(
    getToolRuntimeAvailability("synchron-tasks", {}, ENV).code,
    "CAPABILITY_AUTH_REQUIRED",
  );
});

test("workspace and tasks fail closed on an invalid persistence backend", async () => {
  const invalidEnv = {
    ...ENV,
    PERSISTENCE_BACKEND: "unexpected-storage",
  };
  await assert.rejects(
    () => loadWorkspaceState("owner-a", { env: invalidEnv }),
    (error) => error.code === "WORKSPACE_STORAGE_UNAVAILABLE",
  );
  await assert.rejects(
    () => listTasks({ ownerId: "owner-a" }, { env: invalidEnv }),
    (error) => error.code === "TASK_STORAGE_UNAVAILABLE",
  );
});
