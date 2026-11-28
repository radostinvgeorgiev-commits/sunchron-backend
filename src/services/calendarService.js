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
import {
  executeAuditedWriteAction,
  isAuditSafetyError,
} from "./permissionService.js";
import { googleConnectUrl as siteGoogleConnectUrl } from "../config/publicOrigin.js";

const CALENDAR_ACTION = "calendar.write:create_event";
const CONFIRM_PREFIX = "Потвърждавам календарно събитие:";
const REMINDER_CONFIRM_PREFIX = "Потвърждавам календарно напомняне:";
const TIME_ZONE = "Europe/Sofia";
// The limits the event checks use (title, location and description in
// characters); an English page states the same values.
export const CALENDAR_LIMITS = Object.freeze({
  title: 200,
  location: 500,
  description: 2000,
  minDurationMinutes: 5,
  maxDurationMinutes: 1440,
  maxReminderMinutes: 28 * 24 * 60,
});
// Each text field's name in the Bulgarian messages.
const FIELD_LABELS = Object.freeze({
  title: "заглавие",
  location: "мястото",
  description: "описанието",
});
const MAX_REMINDER_MINUTES = CALENDAR_LIMITS.maxReminderMinutes;
const REMINDER_EVENT_DURATION_MINUTES = 5;

function sessionFingerprint(value) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function formatHelp() {
  return [
    "Използвай един от точните формати:",
    "Създай събитие: Заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | продължителност в минути | място (по желание) | описание (по желание)",
    "Напомни ми: Заглавие | ГГГГ-ММ-ДД ЧЧ:ММ | 30 минути преди",
  ].join("\n");
}

function invalidDraft(message, code = "CALENDAR_EVENT_FORMAT_REQUIRED") {
  return new GoogleDriveError(`${message}\n${formatHelp()}`, 400, code);
}

function cleanLimitedText(value, field, required = false) {
  const text = typeof value === "string" ? value.trim() : "";
  const label = FIELD_LABELS[field];
  const limit = CALENDAR_LIMITS[field];
  if (required && !text) {
    throw invalidDraft(`Липсва ${label}.`, "CALENDAR_EVENT_FIELD_MISSING");
  }
  if (text.length > limit) {
    // The field goes with the error, so an English page can name it too.
    throw Object.assign(
      invalidDraft(
        `${label} е прекалено дълго. Максимумът е ${limit} знака.`,
        "CALENDAR_EVENT_FIELD_TOO_LONG",
      ),
      { field },
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
  const { minDurationMinutes: min, maxDurationMinutes: max } = CALENDAR_LIMITS;
  if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
    throw invalidDraft(
      `Продължителността трябва да е между ${min} и ${max} минути.`,
      "CALENDAR_EVENT_DURATION_INVALID",
    );
  }
  return minutes;
}

function parseReminderMinutes(value) {
  const match = String(value || "").match(
    /^(\d{1,5})\s*(?:мин(?:ути?)?|minutes?)\s+преди$/iu,
  );
  const minutes = match ? Number(match[1]) : -1;
  if (
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > MAX_REMINDER_MINUTES
  ) {
    throw invalidDraft(
      `Напомнянето трябва да е между 0 и ${MAX_REMINDER_MINUTES} минути преди събитието.`,
      "CALENDAR_REMINDER_OFFSET_INVALID",
    );
  }
  return minutes;
}

function isValidReminderMinutes(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_MINUTES;
}

function addMinutes(localStamp, minutes) {
  return new Date(localStamp.getTime() + minutes * 60_000)
    .toISOString()
    .slice(0, 19);
}

function isReminderWriteRequest(message) {
  const text = typeof message === "string" ? message.trim() : "";
  return /^(?:моля[,\s]+)?напомни\s+ми(?=\s|:|$)/iu.test(text);
}

// "Създай събитие в календара: …", "Create a calendar event: …",
// "Add an event to my calendar: …".
export function isCalendarWriteRequest(message) {
  const text = typeof message === "string" ? message.trim() : "";
  return (
    /(?:създай|добави|запиши|направи)\s+(?:ми\s+)?(?:календарно\s+)?(?:събитие|среща|ангажимент)(?:\s+в\s+(?:google\s+)?календара)?/iu.test(
      text,
    ) ||
    /\b(?:create|add|schedule|make|book)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?(?:calendar\s+)?(?:event|meeting|appointment)\b/iu.test(
      text,
    ) ||
    isReminderWriteRequest(text)
  );
}

// The person's day in their own words (item 3, fix 3; Team 2's probe 28.11:
// „какво ми е деня днес“ got „нямам актуална проверка на календара“):
// „какво ми е деня днес“, „моят ден“, „как ми е денят утре“, „какво имам
// днес“, „какво ми предстои утре“, "what's my day", "what do I have today".
// Not when the words name another of the person's things (mail, files,
// contacts, tasks): those have their own tools.
const DAY_WORDS =
  /(?:(?<!\p{L})(?:деня|денят)\s+(?:ми|ти)(?!\p{L})|(?<!\p{L})(?:ми|ти)\s+е\s+(?:деня|денят|ден)(?!\p{L})|(?<!\p{L})мо(?:я|ят|йт)\s+ден(?!\p{L})|(?<!\p{L})(?:какво|кво|каво|що)\s+(?:имам|ми\s+предстои)\s+(?:днес|утре|вдругиден|тази\s+седмица|този\s+уикенд|в\s+(?:понеделник|вторник|сряда|четвъртък|петък|събота|неделя))(?!\p{L}))/u;
const ENGLISH_DAY_WORDS =
  /\b(?:what(?:'s|\s+is)\s+my\s+day|how(?:'s|\s+is)\s+my\s+day|what\s+do\s+i\s+have\s+(?:today|tomorrow|this\s+week|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)))\b/u;
const OTHER_OWN_THINGS =
  /(?:ме[йи]л|маил|писм|пощ|пошт|gmail|джимейл|драйв|drive|файл|документ|контакт|задач|e-?mail|inbox|files?\b|contacts?\b|tasks?\b|to-?do)/u;

// The day a question about the person's own day asks for, as YYYY-MM-DD, or
// "" when the message is no such question (`today` is Sofia's date): „какво
// ми е деня днес“, „моят ден“ and „как ми е денят“ are today, „какво имам
// утре“ is tomorrow and „вдругиден“ the day after. A week or a weekday is a
// calendar question, not one day.
export function myDayAsked(message, today) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(today || ""))) return "";
  if (!(DAY_WORDS.test(text) || ENGLISH_DAY_WORDS.test(text)) || OTHER_OWN_THINGS.test(text)) return "";
  if (/(?:седмица|уикенд|понеделник|вторник|сряда|четвъртък|петък|събота|неделя|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/u.test(text)) {
    return "";
  }
  const shift = /(?:вдругиден|day\s+after\s+tomorrow)/u.test(text) ? 2 : /(?:утре|tomorrow)/u.test(text) ? 1 : 0;
  return new Date(Date.parse(`${today}T12:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10);
}

export function isCalendarReadRequest(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return (
    (/(?:календар|събития|ангажимент|срещи|програмата ми)/u.test(text) ||
      /\bmy\s+(?:google\s+)?(?:calendar|events|meetings|schedule|agenda)\b/u.test(text) ||
      ((DAY_WORDS.test(text) || ENGLISH_DAY_WORDS.test(text)) && !OTHER_OWN_THINGS.test(text))) &&
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
  const isReminder = isReminderWriteRequest(segments[0]);
  if (isReminder) {
    if (segments.length !== 3) {
      throw invalidDraft("Липсват точни данни за напомнянето.");
    }
    const title = cleanLimitedText(
      segments[0].replace(/^(?:моля[,\s]+)?напомни\s+ми\s*:\s*/iu, ""),
      "title",
      true,
    );
    const start = parseLocalDateTime(segments[1]);
    const reminderMinutes = parseReminderMinutes(segments[2]);
    return Object.freeze({
      title,
      start: start.dateTime,
      end: addMinutes(start.stamp, REMINDER_EVENT_DURATION_MINUTES),
      durationMinutes: REMINDER_EVENT_DURATION_MINUTES,
      timeZone: TIME_ZONE,
      location: "",
      description: "",
      reminderMinutes,
    });
  }
  if (segments.length < 3 || segments.length > 5) {
    throw invalidDraft("Липсват точни данни за събитието.");
  }

  const title = cleanLimitedText(
    segments[0].replace(
      /^.*?(?:събитие|среща|ангажимент|event|meeting|appointment)(?:\s+(?:в\s+(?:google\s+)?календара|(?:in|to|on)\s+(?:my\s+|the\s+)?(?:google\s+)?calendar))?\s*:\s*/iu,
      "",
    ),
    "title",
    true,
  );
  const start = parseLocalDateTime(segments[1]);
  const durationMinutes = parseDuration(segments[2]);
  const location = cleanLimitedText(segments[3], "location");
  const description = cleanLimitedText(segments[4], "description");

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
      `Google Calendar не е свързан. [Свържи Google](${siteGoogleConnectUrl()}).`,
      401,
      "NOT_CONNECTED",
    );
  }
  const draft = parseCalendarEventDraft(message);
  const isReminder = isValidReminderMinutes(draft.reminderMinutes);
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
      ...(isReminder ? { reminderMinutes: draft.reminderMinutes } : {}),
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
      isReminder
        ? "Подготвих календарното напомняне, но още не съм го записал."
        : "Подготвих календарното събитие, но още не съм го записал.",
      `Заглавие: ${draft.title}`,
      "Календар: основен (primary)",
      `Начало: ${draft.start.replace("T", " ")} (${draft.timeZone})`,
      ...(isReminder
        ? [`Напомняне: ${draft.reminderMinutes} минути преди`]
        : [`Продължителност: ${draft.durationMinutes} минути`]),
      ...(draft.location ? [`Място: ${draft.location}`] : []),
      ...(draft.description ? [`Описание: ${draft.description}`] : []),
      "За запис изпрати точно:",
      `${isReminder ? REMINDER_CONFIRM_PREFIX : CONFIRM_PREFIX} ${confirmation.id}`,
    ].join("\n"),
  };
}

export function extractCalendarConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^Потвърждавам календарно (?:събитие|напомняне):\s*([0-9a-f]{8}-[0-9a-f-]{27,})$/iu,
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
  executeWrite = executeAuditedWriteAction,
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
  const reminderMinutes = confirmation.resource.reminderMinutes;
  if (
    reminderMinutes !== undefined &&
    !isValidReminderMinutes(reminderMinutes)
  ) {
    throw new GoogleDriveError(
      "Потвърждението съдържа невалидно календарно напомняне.",
      400,
      "CALENDAR_REMINDER_OFFSET_INVALID",
    );
  }
  await consumeConfirmation(confirmationId);
  try {
    return await executeWrite({
      action: "calendar.write",
      capability: "calendar.write",
      sessionId,
      confirmationId,
      resource: "primary-calendar",
      details:
        reminderMinutes !== undefined ? "create_reminder" : "create_event",
      execute: () =>
        createEvent(googleSessionId, {
          title: confirmation.resource.title,
          start: confirmation.resource.start,
          end: confirmation.resource.end,
          timeZone: confirmation.resource.timeZone,
          location: confirmation.params.location || "",
          description: confirmation.params.description || "",
          ...(reminderMinutes !== undefined ? { reminderMinutes } : {}),
        }),
    });
  } catch (error) {
    if (isAuditSafetyError(error)) {
      throw new GoogleDriveError(error.message, error.status, error.code);
    }
    throw error;
  }
}

export function formatCalendarEventResult(event) {
  const isReminder = isValidReminderMinutes(event.reminderMinutes);
  return [
    isReminder
      ? "Напомнянето е записано в Google Calendar."
      : "Събитието е записано в Google Calendar.",
    `Заглавие: ${event.title}`,
    `Начало: ${String(event.start || "").replace("T", " ")}`,
    ...(isReminder ? [`Напомняне: ${event.reminderMinutes} минути преди`] : []),
    ...(event.url ? [`Отвори: ${event.url}`] : []),
  ].join("\n");
}
