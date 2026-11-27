import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfirmation,
  createTaskConfirmation,
  resetConfirmationsForTests,
} from "../src/services/confirmationService.js";
import {
  confirmTaskWrite,
  extractTaskConfirmationId,
  formatConfirmedTask,
  formatTaskConfirmation,
} from "../src/services/taskConfirmationService.js";

test.beforeEach(() => resetConfirmationsForTests());

test("task confirmation executes each prepared operation once", async () => {
  const calls = [];
  const group = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "session-1",
    taskId: "task-1",
    items: [
      {
        confirmationId: "cloud-1",
        capability: "infrastructure.googlecloud.write",
        toolId: "google-cloud-write",
      },
      {
        confirmationId: "github-1",
        capability: "github.pull-request.merge",
        toolId: "github-confirmed-write",
      },
    ],
    createConfirmation,
  });

  const result = await confirmTaskWrite({
    ownerId: "owner-1",
    sessionId: "session-1",
    taskConfirmationId: group.confirmationId,
    taskId: "task-1",
    executeCapability: async (capability, input, options) => {
      calls.push({ capability, input, options });
      return { output: "ok" };
    },
    confirmCodeTask: async () => {
      throw new Error("code task is not expected in this fixture");
    },
  });

  assert.equal(result.results.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((item) => item.input.confirmationId),
    ["cloud-1", "github-1"],
  );
  assert.deepEqual(
    calls.map((item) => item.options),
    [
      { confirmed: true, env: process.env },
      { confirmed: true, env: process.env },
    ],
  );

  await assert.rejects(
    () =>
      confirmTaskWrite({
        ownerId: "owner-1",
        sessionId: "session-1",
        taskConfirmationId: group.confirmationId,
        taskId: "task-1",
        executeCapability: async () => ({ output: "should not run" }),
      }),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
});

test("task confirmation parser accepts only the exact owner command", () => {
  assert.equal(
    extractTaskConfirmationId(
      "Потвърждавам Novarium задача: 12345678-1234-1234-1234-123456789012",
    ),
    "12345678-1234-1234-1234-123456789012",
  );
  assert.equal(extractTaskConfirmationId("да, изпълни"), null);
  assert.equal(
    extractTaskConfirmationId(
      "Confirm Novarium task: 12345678-1234-1234-1234-123456789012",
    ),
    "12345678-1234-1234-1234-123456789012",
  );
});

test("the confirmation says what each step will do, in the person's language", () => {
  const confirmation = {
    confirmationId: "12345678-1234-1234-1234-123456789012",
    expiresAt: "2026-11-27T10:00:00.000Z",
    items: [{ capability: "mail.send" }],
  };
  const english = formatTaskConfirmation(confirmation, true, [
    "Send an email to ana@example.com (subject: Hello).",
  ]);
  assert.match(english, /^Ready, but nothing has been done yet:\n\n- Send an email to ana@example\.com/u);
  assert.match(english, /press Confirm or send this exact command: Confirm Novarium task: 12345678-1234-1234-1234-123456789012$/u);
  const bulgarian = formatTaskConfirmation(confirmation, false, [
    "Изпращане на имейл до ana@example.com (тема: Здравей).",
  ]);
  assert.match(bulgarian, /\n- Изпращане на имейл до ana@example\.com/u);
  assert.match(bulgarian, /Потвърждавам Novarium задача: 12345678-1234-1234-1234-123456789012$/u);
  assert.match(formatTaskConfirmation(confirmation, false), /Подготвих 1 точни записващи операции/u);

  const confirmed = { results: [{ result: { output: "Email sent to ana@example.com." } }] };
  assert.equal(
    formatConfirmedTask(confirmed, true),
    "Done: the confirmed Novarium task ran 1 operation.\n\n- Email sent to ana@example.com.",
  );
  assert.match(formatConfirmedTask(confirmed, false), /^Потвърдената Novarium задача е изпълнена: 1 операции\./u);
});

test("a member confirms only steps on their own Google; anything else stops the whole task first", async () => {
  const memberSteps = (capability) => ["calendar.write", "mail.send", "contacts.create"].includes(capability);
  const run = async (items) => {
    const calls = [];
    const group = await createTaskConfirmation({
      ownerId: "member-1",
      sessionId: "session-1",
      taskId: "task-1",
      items,
      createConfirmation,
    });
    const outcome = await confirmTaskWrite({
      ownerId: "member-1",
      sessionId: "session-1",
      taskConfirmationId: group.confirmationId,
      taskId: "task-1",
      allowItem: (item) => memberSteps(item.capability),
      executeCapability: async (capability) => {
        calls.push(capability);
        return { output: "ok" };
      },
      confirmCodeTask: async () => {
        throw new Error("code task is not expected in this fixture");
      },
    }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    return { calls, ...outcome };
  };

  const mixed = await run([
    { confirmationId: "mail-1", capability: "mail.send", toolId: "gmail-read" },
    { confirmationId: "cloud-1", capability: "infrastructure.googlecloud.write", toolId: "google-cloud-write" },
  ]);
  assert.equal(mixed.error?.code, "OWNER_ONLY");
  assert.equal(mixed.error?.status, 403);
  assert.deepEqual(mixed.calls, []);

  const own = await run([
    { confirmationId: "event-1", capability: "calendar.write", toolId: "google-calendar-write" },
    { confirmationId: "contact-1", capability: "contacts.create", toolId: "google-contacts" },
  ]);
  assert.equal(own.error, undefined);
  assert.deepEqual(own.calls, ["calendar.write", "contacts.create"]);
});
