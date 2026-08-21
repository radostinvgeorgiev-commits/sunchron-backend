import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  cancelTaskRun,
  createTaskRun,
  getTaskRun,
  listTaskRuns,
  pauseTaskRun,
  recordTaskRunCheckpoint,
  resumeTaskRun,
  setFirestoreTaskRunStoreForTests,
} from "../src/services/taskRunService.js";

const env = {
  PERSISTENCE_BACKEND: "firestore",
  GOOGLE_CLOUD_PROJECT: "handy-boulevard-479120-q9",
  FIRESTORE_DATABASE_ID: "(default)",
};

function fakeStore() {
  const documents = new Map();
  return {
    documents,
    async get(id) {
      const data = documents.get(id);
      return data ? { id, data: structuredClone(data) } : null;
    },
    async set(id, data) {
      documents.set(id, structuredClone(data));
    },
    async listByOwner(ownerHash) {
      return [...documents.entries()]
        .filter(([, data]) => data.ownerHash === ownerHash)
        .map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
  };
}

afterEach(() => setFirestoreTaskRunStoreForTests(null));

test("task runs persist checkpoints without exposing the owner", async () => {
  const store = fakeStore();
  setFirestoreTaskRunStoreForTests(store);
  const run = await createTaskRun(
    {
      ownerId: "owner-secret",
      sessionId: "session-1",
      title: "Провери production",
      steps: ["Планирай", "Провери", "Докладвай"],
    },
    { env, createId: () => "run-1", now: () => "2026-08-21T10:00:00.000Z" },
  );

  assert.equal(run.status, "queued");
  assert.equal(run.steps.length, 3);
  assert.equal(run.checkpoints.length, 1);
  const stored = store.documents.get(run.id);
  assert.equal(stored.ownerHash.length, 64);
  assert.equal(JSON.stringify(stored).includes("owner-secret"), false);
});

test("task runs support pause, resume and completion from the last checkpoint", async () => {
  const store = fakeStore();
  setFirestoreTaskRunStoreForTests(store);
  const options = { env, now: () => "2026-08-21T10:00:00.000Z" };
  const created = await createTaskRun(
    {
      ownerId: "owner-1",
      sessionId: "session-1",
      title: "Последователна задача",
      steps: ["Първа", "Втора"],
    },
    options,
  );
  const planning = await recordTaskRunCheckpoint(
    {
      ownerId: "owner-1",
      runId: created.id,
      status: "planning",
      message: "Избирам следващата стъпка.",
      stepIndex: 0,
    },
    options,
  );
  assert.equal(planning.status, "planning");

  const paused = await pauseTaskRun(
    { ownerId: "owner-1", runId: created.id, reason: "Потребителят зададе въпрос." },
    options,
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedReason, "Потребителят зададе въпрос.");

  const resumed = await resumeTaskRun(
    { ownerId: "owner-1", runId: created.id },
    options,
  );
  assert.equal(resumed.status, "running");
  assert.equal(resumed.currentStep, 0);

  const completed = await recordTaskRunCheckpoint(
    {
      ownerId: "owner-1",
      runId: created.id,
      status: "completed",
      stepIndex: 1,
      message: "Всички стъпки са проверени.",
    },
    options,
  );
  assert.equal(completed.status, "completed");
  assert.ok(completed.steps.every((step) => step.status === "completed"));
  assert.equal(completed.pausedReason, null);
});

test("partial task runs remain resumable after a mixed execution", async () => {
  const store = fakeStore();
  setFirestoreTaskRunStoreForTests(store);
  const options = { env, now: () => "2026-08-21T10:00:00.000Z" };
  const created = await createTaskRun(
    { ownerId: "owner-partial", title: "Смесена задача", steps: ["Първа", "Втора"] },
    options,
  );
  await recordTaskRunCheckpoint(
    {
      ownerId: "owner-partial",
      runId: created.id,
      status: "planning",
      stepIndex: 0,
      message: "Планът е готов.",
    },
    options,
  );
  await recordTaskRunCheckpoint(
    {
      ownerId: "owner-partial",
      runId: created.id,
      status: "running",
      stepIndex: 0,
      message: "Започвам изпълнението.",
    },
    options,
  );
  await recordTaskRunCheckpoint(
    {
      ownerId: "owner-partial",
      runId: created.id,
      status: "partial",
      stepIndex: 1,
      message: "Първата стъпка е готова, втората изисква повторение.",
    },
    options,
  );
  const resumed = await resumeTaskRun(
    { ownerId: "owner-partial", runId: created.id },
    options,
  );
  assert.equal(resumed.status, "running");
  assert.equal(resumed.currentStep, 1);
});

test("task runs enforce owner isolation and valid transitions", async () => {
  const store = fakeStore();
  setFirestoreTaskRunStoreForTests(store);
  const created = await createTaskRun(
    { ownerId: "owner-1", title: "Защитена задача" },
    { env, createId: () => "run-owner" },
  );

  await assert.rejects(
    () => getTaskRun({ ownerId: "owner-2", runId: created.id }, { env }),
    (error) => error.code === "TASK_RUN_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () =>
      recordTaskRunCheckpoint(
        {
          ownerId: "owner-1",
          runId: created.id,
          status: "completed",
          message: "Не може да приключи преди планиране.",
        },
        { env },
      ),
    (error) => error.code === "TASK_RUN_INVALID_TRANSITION" && error.status === 409,
  );
});

test("task run list is owner-scoped and can filter status", async () => {
  const store = fakeStore();
  setFirestoreTaskRunStoreForTests(store);
  await createTaskRun(
    { ownerId: "owner-1", title: "Чакаща" },
    { env, createId: () => "a", now: () => "2026-08-21T10:00:00.000Z" },
  );
  const second = await createTaskRun(
    { ownerId: "owner-1", title: "За спиране" },
    { env, createId: () => "b", now: () => "2026-08-21T11:00:00.000Z" },
  );
  await cancelTaskRun({ ownerId: "owner-1", runId: second.id }, { env });
  await createTaskRun(
    { ownerId: "owner-2", title: "Друг профил" },
    { env, createId: () => "c" },
  );

  const items = await listTaskRuns({ ownerId: "owner-1" }, { env });
  assert.deepEqual(items.map((item) => item.id), ["run-b", "run-a"]);
  const cancelled = await listTaskRuns(
    { ownerId: "owner-1", status: "cancelled" },
    { env },
  );
  assert.deepEqual(cancelled.map((item) => item.id), ["run-b"]);
});
