import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmCalendarEvent,
  extractCalendarConfirmationId,
  formatCalendarEventResult,
  isCalendarReadRequest,
  isCalendarWriteRequest,
  parseCalendarEventDraft,
  prepareCalendarEvent,
} from "../src/services/calendarService.js";

test("recognizes calendar questions without owning a second OAuth flow", () => {
  assert.equal(isCalendarReadRequest("Какво имам в календара?"), true);
  assert.equal(isCalendarReadRequest("Покажи срещите ми."), true);
  assert.equal(isCalendarReadRequest("Как работи GitHub?"), false);
});

test("recognizes a calendar write without also routing it as a read", () => {
  const message =
    "Създай събитие: Среща с Иван | 2026-08-05 14:30 | 60 минути | Варна";
  assert.equal(isCalendarWriteRequest(message), true);
  assert.equal(isCalendarReadRequest(message), false);
});

test("parses and validates an exact Sofia calendar draft", () => {
  const draft = parseCalendarEventDraft(
    "Създай събитие: Среща с Иван | 2026-08-05 14:30 | 60 минути | Варна | Подготовка",
  );
  assert.deepEqual(draft, {
    title: "Среща с Иван",
    start: "2026-08-05T14:30:00",
    end: "2026-08-05T15:30:00",
    durationMinutes: 60,
    timeZone: "Europe/Sofia",
    location: "Варна",
    description: "Подготовка",
  });
});

test("rejects an impossible date before creating a confirmation", () => {
  assert.throws(
    () =>
      parseCalendarEventDraft(
        "Създай събитие: Невалидно | 2026-02-30 14:30 | 60",
      ),
    (error) => error.code === "CALENDAR_EVENT_DATE_INVALID",
  );
});

test("prepares an exact one-time confirmation without creating an event", async () => {
  const confirmations = [];
  const prepared = await prepareCalendarEvent({
    sessionId: "chat-session",
    googleSessionId: "google-session",
    message: "Създай събитие: Среща | 2026-08-05 14:30 | 45",
    checkSession: async () => true,
    createConfirmation: async (input) => {
      confirmations.push(input);
      return { id: "confirmation-calendar", expiresAt: Date.now() + 60_000 };
    },
  });

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].action, "calendar.write:create_event");
  assert.equal(confirmations[0].resource.title, "Среща");
  assert.match(
    confirmations[0].resource.googleSessionFingerprint,
    /^[0-9a-f]{64}$/u,
  );
  assert.doesNotMatch(
    JSON.stringify(confirmations[0]),
    /google-session/u,
  );
  assert.match(prepared.output, /още не съм го записал/u);
  assert.match(prepared.output, /confirmation-calendar/u);
});

test("consumes the exact confirmation before one external calendar write", async () => {
  const order = [];
  const result = await confirmCalendarEvent({
    confirmationId: "confirmation-calendar",
    sessionId: "chat-session",
    googleSessionId: "google-session",
    validateConfirmation: async (id, sessionId) => {
      order.push(`validate:${id}:${sessionId}`);
      return {
        action: "calendar.write:create_event",
        resource: {
          title: "Среща",
          start: "2026-08-05T14:30:00",
          end: "2026-08-05T15:15:00",
          timeZone: "Europe/Sofia",
          googleSessionFingerprint:
            "1a92e8a09da51712cb71a8aadd4eed42670e26db5c6ae6ced63bce130d6a307f",
        },
        params: { location: "Варна", description: "" },
      };
    },
    consumeConfirmation: async (id) => order.push(`consume:${id}`),
    createEvent: async (googleSessionId, event) => {
      order.push(`create:${googleSessionId}:${event.title}`);
      return {
        id: "event-1",
        title: event.title,
        start: event.start,
        url: "https://calendar.google.com/event?eid=safe",
      };
    },
  });

  assert.deepEqual(order, [
    "validate:confirmation-calendar:chat-session",
    "consume:confirmation-calendar",
    "create:google-session:Среща",
  ]);
  assert.match(formatCalendarEventResult(result), /event\?eid=safe/u);
});

test("blocks a different Google session before consuming the confirmation", async () => {
  let consumed = false;
  await assert.rejects(
    () =>
      confirmCalendarEvent({
        confirmationId: "confirmation-calendar",
        sessionId: "chat-session",
        googleSessionId: "different-google-session",
        validateConfirmation: async () => ({
          action: "calendar.write:create_event",
          resource: {
            title: "Среща",
            start: "2026-08-05T14:30:00",
            end: "2026-08-05T15:15:00",
            timeZone: "Europe/Sofia",
            googleSessionFingerprint:
              "c5418bc21387d3d090e6de01ac1d267a936a8f8adf901777becab580c1dbfb42",
          },
          params: {},
        }),
        consumeConfirmation: async () => {
          consumed = true;
        },
        createEvent: async () => assert.fail("must not write"),
      }),
    (error) => error.code === "GOOGLE_SESSION_MISMATCH",
  );
  assert.equal(consumed, false);
});

test("extracts only the dedicated calendar confirmation phrase", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    extractCalendarConfirmationId(`Потвърждавам календарно събитие: ${id}`),
    id,
  );
  assert.equal(extractCalendarConfirmationId(`Да ${id}`), null);
});
