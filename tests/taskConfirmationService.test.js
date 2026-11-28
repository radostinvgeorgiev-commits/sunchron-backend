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
      "Потвърждавам NovariumAI задача: 12345678-1234-1234-1234-123456789012",
    ),
    "12345678-1234-1234-1234-123456789012",
  );
  assert.equal(extractTaskConfirmationId("да, изпълни"), null);
  assert.equal(
    extractTaskConfirmationId(
      "Confirm NovariumAI task: 12345678-1234-1234-1234-123456789012",
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
  assert.match(english, /press Confirm or send this exact command: Confirm NovariumAI task: 12345678-1234-1234-1234-123456789012$/u);
  const bulgarian = formatTaskConfirmation(confirmation, false, [
    "Изпращане на имейл до ana@example.com (тема: Здравей).",
  ]);
  assert.match(bulgarian, /\n- Изпращане на имейл до ana@example\.com/u);
  assert.match(bulgarian, /Потвърждавам NovariumAI задача: 12345678-1234-1234-1234-123456789012$/u);
  assert.match(formatTaskConfirmation(confirmation, false), /Подготвих 1 точни записващи операции/u);

  const confirmed = { results: [{ result: { output: "Email sent to ana@example.com." } }] };
  assert.equal(
    formatConfirmedTask(confirmed, true),
    "Done: the confirmed NovariumAI task ran 1 operation.\n\n- Email sent to ana@example.com.",
  );
  assert.match(formatConfirmedTask(confirmed, false), /^Потвърдената NovariumAI задача е изпълнена: 1 операции\./u);
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

test("a step on a tool turned off in „Инструменти“ stops the whole task, and the confirmation stays", async () => {
  const calls = [];
  const group = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "session-1",
    taskId: "task-1",
    items: [
      { confirmationId: "event-1", capability: "calendar.write", toolId: "google-calendar-write" },
      { confirmationId: "mail-1", capability: "mail.send", toolId: "gmail-read" },
    ],
    createConfirmation,
  });
  const confirm = (capabilitiesOff, language) =>
    confirmTaskWrite({
      ownerId: "owner-1",
      sessionId: "session-1",
      taskConfirmationId: group.confirmationId,
      taskId: "task-1",
      language,
      capabilitiesOff,
      executeCapability: async (capability) => {
        calls.push(capability);
        return { output: "ok" };
      },
      confirmCodeTask: async () => {
        throw new Error("code task is not expected in this fixture");
      },
    });

  // Gmail is off: nothing runs, not even the calendar step before it.
  await assert.rejects(
    () => confirm(new Set(["mail.send", "mail.read"])),
    (error) =>
      error.code === "TOOL_SWITCHED_OFF" &&
      error.status === 409 &&
      /разкачен в „Инструменти“/u.test(error.message),
  );
  await assert.rejects(
    () => confirm(new Set(["mail.send"]), "en"),
    (error) => error.code === "TOOL_SWITCHED_OFF" && /turned off in “Tools”/u.test(error.message),
  );
  // The switches could not be read: nothing runs, and it is not called the
  // person's choice.
  const unreadable = new Set(["mail.send", "calendar.write"]);
  unreadable.unavailable = true;
  await assert.rejects(
    () => confirm(unreadable),
    (error) => error.code === "TOOL_SWITCHED_OFF" && /не се прочетоха/u.test(error.message),
  );
  assert.deepEqual(calls, []);

  // Gmail is on again: the same confirmation runs, once.
  const done = await confirm(new Set());
  assert.equal(done.results.length, 2);
  assert.deepEqual(calls, ["calendar.write", "mail.send"]);
  await assert.rejects(() => confirm(new Set()), (error) => error.code === "CONFIRMATION_NOT_FOUND");
});

test("each step runs under the session it was prepared in, the task under its own", async () => {
  // The connector (item 3, fix 1b): the steps under the owner, the task
  // under the conversation.
  const group = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "mcp-conversation",
    taskId: "task-1",
    items: [
      { confirmationId: "mail-1", capability: "mail.send", toolId: "gmail-read" },
      { confirmationId: "code-1", capability: "code.write", toolId: "github-write", confirmationType: "code-task" },
    ],
    createConfirmation,
  });
  const steps = [];
  const codeTasks = [];
  await confirmTaskWrite({
    ownerId: "owner-1",
    sessionId: "mcp-conversation",
    itemSessionId: "owner-1",
    taskConfirmationId: group.confirmationId,
    executeCapability: async (capability, input) => {
      steps.push(input.sessionId);
      return { output: "ok" };
    },
    confirmCodeTask: async (input) => {
      codeTasks.push(input.sessionId);
      return { ok: true };
    },
  });
  assert.deepEqual(steps, ["owner-1"]);
  assert.deepEqual(codeTasks, ["owner-1"]);

  // The site keeps one session for both.
  const site = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "chat-session",
    taskId: "task-2",
    items: [{ confirmationId: "mail-2", capability: "mail.send", toolId: "gmail-read" }],
    createConfirmation,
  });
  const siteSteps = [];
  await confirmTaskWrite({
    ownerId: "owner-1",
    sessionId: "chat-session",
    taskConfirmationId: site.confirmationId,
    executeCapability: async (capability, input) => {
      siteSteps.push(input.sessionId);
      return { output: "ok" };
    },
  });
  assert.deepEqual(siteSteps, ["chat-session"]);

  // The task itself is still checked against its conversation.
  const other = await createTaskConfirmation({
    ownerId: "owner-1",
    sessionId: "mcp-conversation",
    taskId: "task-3",
    items: [{ confirmationId: "mail-3", capability: "mail.send", toolId: "gmail-read" }],
    createConfirmation,
  });
  await assert.rejects(
    confirmTaskWrite({
      ownerId: "owner-1",
      sessionId: "mcp-other-conversation",
      itemSessionId: "owner-1",
      taskConfirmationId: other.confirmationId,
      executeCapability: async () => assert.fail("nothing runs"),
    }),
    (error) => error.code === "SESSION_MISMATCH",
  );
});
