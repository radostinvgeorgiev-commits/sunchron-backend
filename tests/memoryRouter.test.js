import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  CLEAR_MEMORY_CONFIRMATION,
  createProfileMemoryWriteHandler,
  hasClearMemoryConfirmation,
} from "../src/routes/memoryRouter.js";
import { MemoryWriteConfirmationError } from "../src/services/memoryWriteConfirmationService.js";

function requestWithConfirmation(value) {
  return {
    get(name) {
      assert.equal(name, "x-confirm-memory-delete");
      return value;
    },
  };
}

test("memory API deletion requires exact explicit confirmation", () => {
  assert.equal(hasClearMemoryConfirmation(requestWithConfirmation()), false);
  assert.equal(
    hasClearMemoryConfirmation(requestWithConfirmation("да, изтрий")),
    false,
  );
  assert.equal(
    hasClearMemoryConfirmation(
      requestWithConfirmation(CLEAR_MEMORY_CONFIRMATION),
    ),
    true,
  );
});

test("memory deletion confirmation is safe for an HTTP header", () => {
  assert.match(CLEAR_MEMORY_CONFIRMATION, /^[\x20-\x7E]+$/u);
});

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
