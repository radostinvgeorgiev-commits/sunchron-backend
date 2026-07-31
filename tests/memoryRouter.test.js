import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createProfileMemoryDeleteHandler,
  createProfileMemoryWriteHandler,
} from "../src/routes/memoryRouter.js";
import { MemoryDeleteConfirmationError } from "../src/services/memoryDeleteConfirmationService.js";
import { MemoryWriteConfirmationError } from "../src/services/memoryWriteConfirmationService.js";

function writeTestApp(options) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "owner-a" };
    next();
  });
  app.post("/memory/profile", createProfileMemoryWriteHandler(options));
  return app;
}

function deleteTestApp(options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "owner-a" };
    next();
  });
  app.delete(
    "/memory/profile/:id",
    createProfileMemoryDeleteHandler({
      resolveTarget: (req) => ({ kind: "id", id: req.params.id }),
      ...options,
    }),
  );
  return app;
}

test("memory API prepares an exact delete and changes nothing", async () => {
  const auditEvents = [];
  let preparedInput;
  let confirmCalled = false;
  const app = deleteTestApp({
    prepare: async (input) => {
      preparedInput = input;
      return {
        confirmationId: "123e4567-e89b-12d3-a456-426614174000",
        expiresAt: Date.now() + 60_000,
        target: { kind: "id", id: "memory-1" },
      };
    },
    confirm: async () => {
      confirmCalled = true;
      assert.fail("must not delete before confirmation");
    },
    audit: async (event) => auditEvents.push(event),
  });

  const response = await request(app)
    .delete("/memory/profile/memory-1")
    .send({ sessionId: "session-a" })
    .expect(409);

  assert.equal(confirmCalled, false);
  assert.equal(preparedInput.ownerId, "owner-a");
  assert.deepEqual(preparedInput.target, { kind: "id", id: "memory-1" });
  assert.equal(response.body.code, "MEMORY_DELETE_CONFIRMATION_REQUIRED");
  assert.match(response.body.confirmationPhrase, /123e4567/u);
  assert.equal(auditEvents[0].decision, "confirm");
  assert.doesNotMatch(JSON.stringify(auditEvents), /memory-1/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API deletes only through the stored one-time confirmation", async () => {
  const auditEvents = [];
  let confirmedInput;
  const app = deleteTestApp({
    confirm: async (input) => {
      confirmedInput = input;
      return { target: { kind: "id", id: "memory-1" }, deleted: 1 };
    },
    audit: async (event) => auditEvents.push(event),
  });

  const response = await request(app)
    .delete("/memory/profile/memory-1")
    .set(
      "x-confirm-memory-delete",
      "123e4567-e89b-12d3-a456-426614174000",
    )
    .send({ sessionId: "session-a" })
    .expect(200);

  assert.equal(confirmedInput.ownerId, "owner-a");
  assert.equal(confirmedInput.sessionId, "session-a");
  assert.deepEqual(confirmedInput.expectedTarget, {
    kind: "id",
    id: "memory-1",
  });
  assert.equal(response.body.deleted, 1);
  assert.equal(auditEvents[0].decision, "confirmed");
  assert.doesNotMatch(JSON.stringify(auditEvents), /memory-1/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API requires a session before preparing a delete", async () => {
  const app = deleteTestApp();
  const response = await request(app)
    .delete("/memory/profile/memory-1")
    .expect(400);
  assert.equal(response.body.code, "MISSING_SESSION");
});

test("memory API preserves a safe delete confirmation error", async () => {
  const app = deleteTestApp({
    confirm: async () => {
      throw new MemoryDeleteConfirmationError(
        "Профилът или записът не съответства на потвърденото изтриване.",
        403,
        "MEMORY_DELETE_TARGET_MISMATCH",
      );
    },
    audit: async () => {},
  });
  const response = await request(app)
    .delete("/memory/profile/memory-2")
    .set(
      "x-confirm-memory-delete",
      "123e4567-e89b-12d3-a456-426614174000",
    )
    .send({ sessionId: "session-a" })
    .expect(403);
  assert.equal(response.body.code, "MEMORY_DELETE_TARGET_MISMATCH");
});

test("memory API returns 409 and never writes before exact confirmation", async () => {
  const auditEvents = [];
  let preparedInput;
  let confirmCalled = false;
  const app = writeTestApp({
    prepare: async (input) => {
      preparedInput = input;
      return {
        confirmationId: "123e4567-e89b-12d3-a456-426614174000",
        expiresAt: Date.now() + 60_000,
        items: [{ fact: "Частен тестов факт", scope: "personal" }],
      };
    },
    confirm: async () => {
      confirmCalled = true;
      assert.fail("must not confirm or write");
    },
    audit: async (event) => auditEvents.push(event),
  });

  const response = await request(app)
    .post("/memory/profile")
    .send({
      sessionId: "session-a",
      fact: "Частен тестов факт",
      scope: "personal",
    })
    .expect(409);

  assert.equal(confirmCalled, false);
  assert.equal(preparedInput.ownerId, "owner-a");
  assert.equal(response.body.code, "MEMORY_WRITE_CONFIRMATION_REQUIRED");
  assert.match(response.body.confirmationPhrase, /123e4567/u);
  assert.equal(auditEvents[0].decision, "confirm");
  assert.doesNotMatch(JSON.stringify(auditEvents), /Частен тестов факт/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API writes only the fact stored in the one-time confirmation", async () => {
  const auditEvents = [];
  let confirmedInput;
  const app = writeTestApp({
    confirm: async (input) => {
      confirmedInput = input;
      return [
        {
          id: "memory-1",
          fact: "Точният потвърден факт",
          scope: "project",
          replaced: false,
        },
      ];
    },
    audit: async (event) => auditEvents.push(event),
  });

  const response = await request(app)
    .post("/memory/profile")
    .send({
      sessionId: "session-a",
      confirmationId: "123e4567-e89b-12d3-a456-426614174000",
      fact: "Подменен факт, който трябва да бъде игнориран",
    })
    .expect(201);

  assert.equal(confirmedInput.ownerId, "owner-a");
  assert.equal(confirmedInput.sessionId, "session-a");
  assert.equal(confirmedInput.source, "confirmed-memory-api");
  assert.equal(response.body.items[0].fact, "Точният потвърден факт");
  assert.equal(auditEvents[0].decision, "confirmed");
  assert.doesNotMatch(JSON.stringify(auditEvents), /Точният потвърден факт/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API requires a session before preparing a write", async () => {
  const app = writeTestApp();
  const response = await request(app)
    .post("/memory/profile")
    .send({ fact: "Факт без сесия" })
    .expect(400);
  assert.equal(response.body.code, "MISSING_SESSION");
});

test("memory API preserves a safe confirmation error and status", async () => {
  const app = writeTestApp({
    confirm: async () => {
      throw new MemoryWriteConfirmationError(
        "Профилът не съответства на потвърдения запис.",
        403,
        "MEMORY_OWNER_MISMATCH",
      );
    },
    audit: async () => {},
  });

  const response = await request(app)
    .post("/memory/profile")
    .send({
      sessionId: "session-a",
      confirmationId: "123e4567-e89b-12d3-a456-426614174000",
    })
    .expect(403);

  assert.equal(response.body.code, "MEMORY_OWNER_MISMATCH");
  assert.equal(
    response.body.error,
    "Профилът не съответства на потвърдения запис.",
  );
});
