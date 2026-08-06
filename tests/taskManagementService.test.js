import assert from "node:assert/strict";
import test from "node:test";

import {
  addTaskNote,
  confirmTaskStatusChange,
  createTaskDraft,
  linkTaskToProject,
  listTasks,
  prepareTaskStatusChange,
  TASK_STATUS_CONFIRMATION_ACTION,
} from "../src/services/taskManagementService.js";

function memoryClient() {
  const documents = new Map();
  return {
    documents,
    async index({ id, body }) {
      documents.set(id, structuredClone(body));
      return { body: { _id: id, result: "updated" } };
    },
    async get({ id }) {
      if (!documents.has(id)) {
        const error = new Error("not found");
        error.meta = { statusCode: 404 };
        throw error;
      }
      return { body: { _id: id, _source: structuredClone(documents.get(id)) } };
    },
    async search({ body }) {
      const ownerHash = body.query.bool.filter[0].term.ownerHash;
      const hits = [...documents.entries()]
        .filter(([, value]) => value.ownerHash === ownerHash)
        .map(([id, value]) => ({ _id: id, _source: structuredClone(value) }));
      return { body: { hits: { hits } } };
    },
  };
}

test("creates an owner-scoped task draft and lists it without exposing the owner", async () => {
  const client = memoryClient();
  const task = await createTaskDraft(
    {
      ownerId: "supabase:user-1",
      title: "Провери AI разговора",
      projectId: "synchron-x",
      note: "Първо само read-only тест.",
    },
    {
      client,
      createId: () => "11111111-1111-4111-8111-111111111111",
      now: () => "2026-08-06T10:00:00.000Z",
    },
  );

  assert.equal(task.status, "draft");
  assert.equal(task.projectId, "synchron-x");
  assert.equal(task.notes[0].text, "Първо само read-only тест.");
  assert.doesNotMatch(
    JSON.stringify([...client.documents.values()]),
    /supabase:user-1/u,
  );

  const listed = await listTasks({ ownerId: "supabase:user-1" }, { client });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Провери AI разговора");
  assert.equal(
    (await listTasks({ ownerId: "supabase:user-2" }, { client })).length,
    0,
  );
});

test("creates an explicit task index mapping before the first write", async () => {
  const calls = [];
  const client = {
    indices: {
      exists: async ({ index }) => {
        calls.push(["exists", index]);
        return { body: false };
      },
      create: async (input) => {
        calls.push(["create-index", input]);
      },
      putMapping: async () => {
        calls.push(["mapping"]);
      },
    },
    index: async (input) => {
      calls.push(["write", input]);
    },
  };
  await createTaskDraft(
    { ownerId: "owner-1", title: "Mapped task" },
    {
      client,
      createId: () => "66666666-6666-4666-8666-666666666666",
    },
  );

  assert.deepEqual(
    calls.map(([name]) => name),
    ["exists", "create-index", "write"],
  );
  const properties = calls[1][1].body.mappings.properties;
  assert.equal(properties.ownerHash.type, "keyword");
  assert.equal(properties.status.type, "keyword");
  assert.equal(properties.updatedAt.type, "date");
});

test("adds a bounded note without changing task status", async () => {
  const client = memoryClient();
  const task = await createTaskDraft(
    { ownerId: "owner-1", title: "Тест" },
    { client, createId: () => "22222222-2222-4222-8222-222222222222" },
  );
  const updated = await addTaskNote(
    { ownerId: "owner-1", taskId: task.id, note: "Резултатът е зелен." },
    { client, now: () => "2026-08-06T11:00:00.000Z" },
  );

  assert.equal(updated.status, "draft");
  assert.equal(updated.notes.at(-1).text, "Резултатът е зелен.");
});

test("links a task only to a project from the same owner workspace", async () => {
  const client = memoryClient();
  const task = await createTaskDraft(
    { ownerId: "owner-1", title: "Свържи проект" },
    { client, createId: () => "55555555-5555-4555-8555-555555555555" },
  );
  const loadWorkspace = async (ownerId) => ({
    state: {
      projects:
        ownerId === "owner-1" ? [{ id: "project-1", name: "SYNCHRON-X" }] : [],
    },
  });
  const linked = await linkTaskToProject(
    { ownerId: "owner-1", taskId: task.id, projectId: "project-1" },
    { client, loadWorkspace },
  );
  assert.equal(linked.projectId, "project-1");

  await assert.rejects(
    () =>
      linkTaskToProject(
        { ownerId: "owner-1", taskId: task.id, projectId: "foreign-project" },
        { client, loadWorkspace },
      ),
    (error) => error.code === "TASK_PROJECT_NOT_FOUND",
  );
});

test("changes status only after the exact one-time confirmation", async () => {
  const client = memoryClient();
  const task = await createTaskDraft(
    { ownerId: "owner-1", title: "Завърши MCP теста" },
    { client, createId: () => "33333333-3333-4333-8333-333333333333" },
  );
  let storedConfirmation;
  const prepared = await prepareTaskStatusChange(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      taskId: task.id,
      status: "completed",
    },
    {
      client,
      createConfirmation: async (input) => {
        storedConfirmation = {
          id: "confirmation-1",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return storedConfirmation;
      },
    },
  );

  assert.equal(storedConfirmation.action, TASK_STATUS_CONFIRMATION_ACTION);
  assert.equal(prepared.fromStatus, "draft");
  assert.equal(prepared.toStatus, "completed");
  assert.equal(
    (await listTasks({ ownerId: "owner-1" }, { client }))[0].status,
    "draft",
  );

  const order = [];
  const result = await confirmTaskStatusChange(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      confirmationId: "confirmation-1",
    },
    {
      client,
      validateConfirmation: async () => storedConfirmation,
      consumeConfirmation: async () => order.push("consume"),
      executeWrite: async ({ execute, action }) => {
        order.push(`audit:${action}`);
        return execute();
      },
      now: () => "2026-08-06T12:00:00.000Z",
    },
  );

  assert.deepEqual(order, ["consume", "audit:tasks.update"]);
  assert.equal(result.status, "completed");
});

test("blocks a confirmation bound to another owner", async () => {
  const client = memoryClient();
  const task = await createTaskDraft(
    { ownerId: "owner-1", title: "Чужда задача" },
    { client, createId: () => "44444444-4444-4444-8444-444444444444" },
  );
  let confirmation;
  await prepareTaskStatusChange(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      taskId: task.id,
      status: "ready",
    },
    {
      client,
      createConfirmation: async (input) => {
        confirmation = {
          id: "confirmation-2",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return confirmation;
      },
    },
  );

  await assert.rejects(
    () =>
      confirmTaskStatusChange(
        {
          ownerId: "owner-2",
          sessionId: "session-1",
          confirmationId: "confirmation-2",
        },
        { client, validateConfirmation: async () => confirmation },
      ),
    (error) => error.code === "TASK_OWNER_MISMATCH",
  );
});
