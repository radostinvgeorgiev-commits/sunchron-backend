import { createHash } from "node:crypto";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  createGoogleCalendarEvent,
  GoogleDriveError,
  hasSession,
} from "./googleDriveService.js";

const CALENDAR_ACTION = "calendar.write:create_event";
const CONFIRM_PREFIX = "Потвърждавам календарно събитие:";
const TIME_ZONE = "Europe/Sofia";
const MAX_TITLE_LENGTH = 200;
const MAX_LOCATION_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;

function sessionFingerprint(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function formatHelp() {
  return [
    "Използвай точния формат:",
    "Създай събитие: Заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | продължителност в минути | място (по желание) | описание (по желание)",
  ].join("\n");
}

function invalidDraft(message, code = "CALENDAR_EVENT_FORMAT_REQUIRED") {
  return new GoogleDriveError(`${message}\n${formatHelp()}`, 400, code);
}

function cleanLimitedText(value, limit, label, required = false) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) {
    throw invalidDraft(`Липсва ${label}.`, "CALENDAR_EVENT_FIELD_MISSING");
  }
  if (text.length > limit) {
    throw invalidDraft(
      `${label} е прекалено дълго. Максимумът е ${limit} знака.`,
      "CALENDAR_EVENT_FIELD_TOO_LONG",
    );
  }
  return text;
}

function parseLocalDateTime(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/u,
  );
  if (!match) {
    throw invalidDraft(
      "Датата и часът трябва да са например 2026-08-05 14:30.",
      "CALENDAR_EVENT_DATE_INVALID",
    );
  }
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const stamp = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day ||
    stamp.getUTCHours() !== hour ||
    stamp.getUTCMinutes() !== minute
  ) {
    throw invalidDraft(
      "Датата или часът не съществуват.",
      "CALENDAR_EVENT_DATE_INVALID",
    );
  }
  return {
    stamp,
    dateTime: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:00`,
  };
}

function parseDuration(value) {
  const match = String(value || "").match(
    /^(\d{1,4})(?:\s*(?:мин(?:ути?)?|minutes?))?$/iu,
  );
  const minutes = match ? Number(match[1]) : 0;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
    throw invalidDraft(
      "Продължителността трябва да е между 5 и 1440 минути.",
      "CALENDAR_EVENT_DURATION_INVALID",
    );
  }
  return minutes;
}

function addMinutes(localStamp, minutes) {
  return new Date(localStamp.getTime() + minutes * 60_000)
    .toISOString()
    .slice(0, 19);
}

export function isCalendarWriteRequest(message) {
  const text = typeof message === "string" ? message.trim() : "";
  return /(?:създай|добави|запиши|направи)\s+(?:ми\s+)?(?:календарно\s+)?(?:събитие|среща|ангажимент)(?:\s+в\s+(?:google\s+)?календара)?/iu.test(
    text,
  );
}

export function isCalendarReadRequest(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return (
    /(?:календар|събития|ангажимент|срещи|програмата ми)/u.test(text) &&
    !isCalendarWriteRequest(message)
  );
}

export function parseCalendarEventDraft(message) {
  if (!isCalendarWriteRequest(message)) {
    throw invalidDraft("Не разпознах заявка за ново събитие.");
  }
  const segments = String(message)
    .split("|")
    .map((segment) => segment.trim());
  if (segments.length < 3 || segments.length > 5) {
    throw invalidDraft("Липсват точни данни за събитието.");
  }

  const title = cleanLimitedText(
    segments[0].replace(
      /^.*?(?:събитие|среща|ангажимент)(?:\s+в\s+(?:google\s+)?календара)?\s*:\s*/iu,
      "",
    ),
    MAX_TITLE_LENGTH,
    "заглавие",
    true,
  );
  const start = parseLocalDateTime(segments[1]);
  const durationMinutes = parseDuration(segments[2]);
  const location = cleanLimitedText(
    segments[3],
    MAX_LOCATION_LENGTH,
    "мястото",
  );
  const description = cleanLimitedText(
    segments[4],
    MAX_DESCRIPTION_LENGTH,
    "описанието",
  );

  return Object.freeze({
    title,
    start: start.dateTime,
    end: addMinutes(start.stamp, durationMinutes),
    durationMinutes,
    timeZone: TIME_ZONE,
    location,
    description,
  });
}

export async function prepareCalendarEvent({
  sessionId,
  googleSessionId,
  message,
  createConfirmation = createDurableConfirmation,
  checkSession = hasSession,
}) {
  if (!(await checkSession(googleSessionId))) {
    throw new GoogleDriveError(
      "Google Calendar не е свързан. [Свържи Google](https://synchron.foundation/api/google/connect).",
      401,
      "NOT_CONNECTED",
    );
  }
  const draft = parseCalendarEventDraft(message);
  const confirmation = await createConfirmation({
    sessionId,
    action: CALENDAR_ACTION,
    resource: {
      calendarId: "primary",
      googleSessionFingerprint: sessionFingerprint(googleSessionId),
      title: draft.title,
      start: draft.start,
      end: draft.end,
      timeZone: draft.timeZone,
    },
    params: {
      location: draft.location,
      description: draft.description,
    },
  });

  return {
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    draft,
    output: [
      "Подготвих календарното събитие, но още не съм го записал.",
      `Заглавие: ${draft.title}`,
      `Начало: ${draft.start.replace("T", " ")} (${draft.timeZone})`,
      `Продължителност: ${draft.durationMinutes} минути`,
      ...(draft.location ? [`Място: ${draft.location}`] : []),
      ...(draft.description ? [`Описание: ${draft.description}`] : []),
      "За запис изпрати точно:",
      `${CONFIRM_PREFIX} ${confirmation.id}`,
    ].join("\n"),
  };
}

export function extractCalendarConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^Потвърждавам календарно събитие:\s*([0-9a-f]{8}-[0-9a-f-]{27,})$/iu,
    );
  return match?.[1] || null;
}

export async function confirmCalendarEvent({
  confirmationId,
  sessionId,
  googleSessionId,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  createEvent = createGoogleCalendarEvent,
}) {
  let confirmation;
  try {
    confirmation = await validateConfirmation(confirmationId, sessionId);
  } catch (error) {
    const statusByCode = {
      CONFIRMATION_NOT_FOUND: 404,
      CONFIRMATION_EXPIRED: 410,
      SESSION_MISMATCH: 403,
    };
    throw new GoogleDriveError(
      error?.message || "Потвърждението е невалидно.",
      statusByCode[error?.code] || 400,
      error?.code || "CONFIRMATION_INVALID",
    );
  }
  if (confirmation.action !== CALENDAR_ACTION) {
    throw new GoogleDriveError(
      "Потвърждението не е за календарно събитие.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  if (
    confirmation.resource.googleSessionFingerprint !==
    sessionFingerprint(googleSessionId)
  ) {
    throw new GoogleDriveError(
      "Google сесията не съответства на потвърденото събитие. Подготви събитието отново.",
      403,
      "GOOGLE_SESSION_MISMATCH",
    );
  }
  await consumeConfirmation(confirmationId);
  return createEvent(googleSessionId, {
    title: confirmation.resource.title,
    start: confirmation.resource.start,
    end: confirmation.resource.end,
    timeZone: confirmation.resource.timeZone,
    location: confirmation.params.location || "",
    description: confirmation.params.description || "",
  });
}

export function formatCalendarEventResult(event) {
  return [
    "Събитието е записано в Google Calendar.",
    `Заглавие: ${event.title}`,
    `Начало: ${String(event.start || "").replace("T", " ")}`,
    ...(event.url ? [`Отвори: ${event.url}`] : []),
  ].join("\n");
}
