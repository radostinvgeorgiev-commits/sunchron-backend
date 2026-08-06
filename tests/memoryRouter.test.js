import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  createProfileMemoryClearHandler,
  createProfileMemoryDeleteHandler,
  createProfileMemoryWriteHandler,
} from "../src/routes/memoryRouter.js";
import { MemoryWriteConfirmationError } from "../src/services/memoryWriteConfirmationService.js";
import { AuditSafetyError } from "../src/services/permissionService.js";

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

function deleteTestApp({ item = {}, bulk = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = { memoryOwnerId: "owner-a" };
    next();
  });
  app.delete("/memory/profile/:id", createProfileMemoryDeleteHandler(item));
  app.delete("/memory/profile", createProfileMemoryClearHandler(bulk));
  return app;
}

test("memory API rejects the legacy reusable header and prepares a one-time item delete", async () => {
  const auditEvents = [];
  let preparedInput;
  const app = deleteTestApp({
    item: {
      prepare: async (input) => {
        preparedInput = input;
        return {
          confirmationId: "123e4567-e89b-12d3-a456-426614174000",
          expiresAt: Date.now() + 60_000,
          target: input.target,
        };
      },
      confirm: async () => assert.fail("must not delete during preparation"),
      audit: async (event) => auditEvents.push(event),
    },
  });

  await request(app)
    .delete("/memory/profile/memory-private-id")
    .set("x-confirm-memory-delete", "confirm-delete-profile-memory")
    .send({})
    .expect(400);

  const response = await request(app)
    .delete("/memory/profile/memory-private-id")
    .set("x-confirm-memory-delete", "confirm-delete-profile-memory")
    .send({ sessionId: "session-a" })
    .expect(409);

  assert.equal(response.body.code, "MEMORY_DELETE_CONFIRMATION_REQUIRED");
  assert.match(response.body.confirmationPhrase, /123e4567/u);
  assert.deepEqual(preparedInput.target, {
    kind: "id",
    id: "memory-private-id",
  });
  assert.doesNotMatch(JSON.stringify(auditEvents), /memory-private-id/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API performs only the item stored in the exact one-time confirmation", async () => {
  const auditEvents = [];
  let confirmedInput;
  const app = deleteTestApp({
    item: {
      confirm: async (input) => {
        confirmedInput = input;
        return { target: input.expectedTarget, deleted: 1 };
      },
      audit: async (event) => auditEvents.push(event),
    },
  });

  const response = await request(app)
    .delete("/memory/profile/memory-1")
    .send({
      sessionId: "session-a",
      confirmationId: "123e4567-e89b-12d3-a456-426614174000",
    })
    .expect(200);

  assert.equal(confirmedInput.ownerId, "owner-a");
  assert.deepEqual(confirmedInput.expectedTarget, {
    kind: "id",
    id: "memory-1",
  });
  assert.equal(response.body.deleted, 1);
  assert.doesNotMatch(JSON.stringify(auditEvents), /memory-1/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API protects a bulk delete with the exact scope", async () => {
  let preparedInput;
  const app = deleteTestApp({
    bulk: {
      prepare: async (input) => {
        preparedInput = input;
        return {
          confirmationId: "123e4567-e89b-12d3-a456-426614174000",
          expiresAt: Date.now() + 60_000,
          target: input.target,
        };
      },
      audit: async () => {},
    },
  });

  await request(app)
    .delete("/memory/profile?scope=project")
    .send({ sessionId: "session-a" })
    .expect(409);
  assert.deepEqual(preparedInput.target, { kind: "all", scope: "project" });
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
  assert.deepEqual(auditEvents, []);
  assert.doesNotMatch(JSON.stringify(auditEvents), /Точният потвърден факт/u);
  assert.doesNotMatch(JSON.stringify(auditEvents), /123e4567/u);
});

test("memory API binds an edit request to the exact existing memory id", async () => {
  let preparedInput;
  const app = writeTestApp({
    prepare: async (input) => {
      preparedInput = input;
      return {
        confirmationId: "123e4567-e89b-12d3-a456-426614174000",
        expiresAt: Date.now() + 60_000,
        items: input.items,
      };
    },
    audit: async () => {},
  });

  await request(app)
    .post("/memory/profile")
    .send({
      sessionId: "session-a",
      memoryId: "memory-existing",
      fact: "Поправен факт",
      scope: "personal",
    })
    .expect(409);

  assert.equal(preparedInput.ownerId, "owner-a");
  assert.equal(preparedInput.replaceId, "memory-existing");
  assert.deepEqual(preparedInput.items, [
    { fact: "Поправен факт", scope: "personal" },
  ]);
});

test("memory API returns an exact audit safety error without a duplicate audit", async () => {
  const auditEvents = [];
  const app = writeTestApp({
    confirm: async () => {
      throw new AuditSafetyError(
        "Журналът не е достъпен. Действието не беше стартирано.",
        "AUDIT_UNAVAILABLE",
        503,
      );
    },
    audit: async (event) => auditEvents.push(event),
  });

  const response = await request(app)
    .post("/memory/profile")
    .send({
      sessionId: "session-a",
      confirmationId: "123e4567-e89b-12d3-a456-426614174000",
    })
    .expect(503);

  assert.equal(response.body.code, "AUDIT_UNAVAILABLE");
  assert.equal(
    response.body.error,
    "Журналът не е достъпен. Действието не беше стартирано.",
  );
  assert.deepEqual(auditEvents, []);
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
