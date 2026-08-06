import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createTasksRouter } from "../src/routes/tasksRouter.js";

function appWith(options) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "verified-owner" };
    next();
  });
  app.use("/api/tasks", createTasksRouter(options));
  return app;
}

test("task routes always inject the verified owner", async () => {
  const calls = [];
  const app = appWith({
    list: async (input) => {
      calls.push(["list", input]);
      return [];
    },
    createDraft: async (input) => {
      calls.push(["create", input]);
      return { id: "task-1", title: input.title, status: "draft" };
    },
  });

  await request(app)
    .get("/api/tasks?unfinished=true&projectId=project-1")
    .expect(200);
  await request(app)
    .post("/api/tasks")
    .send({ ownerId: "attacker", title: "Провери моста" })
    .expect(201);

  assert.equal(calls[0][1].ownerId, "verified-owner");
  assert.equal(calls[0][1].unfinished, true);
  assert.equal(calls[1][1].ownerId, "verified-owner");
  assert.equal(calls[1][1].title, "Провери моста");
});

test("task status prepare returns 409 and confirmation metadata without changing state", async () => {
  const app = appWith({
    prepareStatus: async (input) => ({
      confirmationId: "confirmation-1",
      expiresAt: "2026-08-06T12:00:00.000Z",
      taskId: input.taskId,
      fromStatus: "draft",
      toStatus: input.status,
    }),
  });

  const response = await request(app)
    .post("/api/tasks/task-1/status/prepare")
    .send({ sessionId: "session-1", status: "completed" })
    .expect(409);

  assert.equal(response.body.code, "TASK_STATUS_CONFIRMATION_REQUIRED");
  assert.equal(response.body.confirmationId, "confirmation-1");
  assert.equal(response.body.toStatus, "completed");
});

test("task routes support notes, project links and exact status confirmation", async () => {
  const calls = [];
  const task = { id: "task-1", title: "Задача", status: "completed" };
  const app = appWith({
    addNote: async (input) => {
      calls.push(["note", input]);
      return task;
    },
    linkProject: async (input) => {
      calls.push(["link", input]);
      return { ...task, projectId: input.projectId };
    },
    confirmStatus: async (input) => {
      calls.push(["confirm", input]);
      return task;
    },
  });

  await request(app)
    .post("/api/tasks/task-1/notes")
    .send({ note: "Проверено" })
    .expect(200);
  await request(app)
    .post("/api/tasks/task-1/project")
    .send({ projectId: "project-1" })
    .expect(200);
  await request(app)
    .post("/api/tasks/status/confirm")
    .send({ sessionId: "session-1", confirmationId: "confirmation-1" })
    .expect(200);

  assert.deepEqual(
    calls.map(([name]) => name),
    ["note", "link", "confirm"],
  );
  assert.ok(calls.every(([, input]) => input.ownerId === "verified-owner"));
});
