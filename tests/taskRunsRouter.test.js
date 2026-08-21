import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import { createTaskRunsRouter } from "../src/routes/taskRunsRouter.js";

function appWith(options) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "verified-owner" };
    next();
  });
  app.use("/api/task-runs", createTaskRunsRouter(options));
  return app;
}

test("task run routes always inject the verified owner", async () => {
  const calls = [];
  const app = appWith({
    create: async (input) => {
      calls.push(["create", input]);
      return { id: "run-1", title: input.title, status: "queued" };
    },
    list: async (input) => {
      calls.push(["list", input]);
      return [];
    },
  });

  await request(app)
    .post("/api/task-runs")
    .send({ ownerId: "attacker", title: "Провери задачата", steps: ["Първа"] })
    .expect(201);
  await request(app)
    .get("/api/task-runs?status=paused&limit=10")
    .expect(200);

  assert.equal(calls[0][1].ownerId, "verified-owner");
  assert.equal(calls[1][1].ownerId, "verified-owner");
  assert.equal(calls[1][1].status, "paused");
});

test("task run routes expose checkpoint, pause, resume and cancel actions", async () => {
  const calls = [];
  const item = { id: "run-1", status: "paused" };
  const app = appWith({
    get: async (input) => {
      calls.push(["get", input]);
      return item;
    },
    checkpoint: async (input) => {
      calls.push(["checkpoint", input]);
      return item;
    },
    pause: async (input) => {
      calls.push(["pause", input]);
      return item;
    },
    resume: async (input) => {
      calls.push(["resume", input]);
      return item;
    },
    cancel: async (input) => {
      calls.push(["cancel", input]);
      return item;
    },
  });

  await request(app).get("/api/task-runs/run-1").expect(200);
  await request(app)
    .post("/api/task-runs/run-1/checkpoints")
    .send({ status: "running", stepIndex: 1, message: "Изпълнявам." })
    .expect(200);
  await request(app)
    .post("/api/task-runs/run-1/pause")
    .send({ reason: "Нов въпрос от потребителя." })
    .expect(200);
  await request(app).post("/api/task-runs/run-1/resume").expect(200);
  await request(app).post("/api/task-runs/run-1/cancel").expect(200);

  assert.deepEqual(
    calls.map(([name]) => name),
    ["get", "checkpoint", "pause", "resume", "cancel"],
  );
  assert.ok(calls.every(([, input]) => input.ownerId === "verified-owner"));
});
