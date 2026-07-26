const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TIMEOUT_MS = 10000;

export class CalendarServiceError extends Error {
  constructor(message, status = 500, code = "CALENDAR_ERROR") {
    super(message);
    this.name = "CalendarServiceError";
    this.status = status;
    this.code = code;
  }
}

function requiredConfig() {
  const config = {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
  };
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new CalendarServiceError(
      "Google Calendar още не е свързан със Synchron-X.",
      503,
      "CALENDAR_NOT_CONFIGURED",
    );
  }
  return config;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new CalendarServiceError(
        "Google Calendar не отговори навреме.",
        504,
        "CALENDAR_TIMEOUT",
      );
    }
    throw new CalendarServiceError(
      "Връзката с Google Calendar не е достъпна.",
      503,
      "CALENDAR_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function accessToken() {
  const config = requiredConfig();
  const response = await fetchWithTimeout(
    process.env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    },
  );
  if (!response.ok) {
    throw new CalendarServiceError(
      "Google Calendar отказа достъпа. Нужно е ново свързване.",
      502,
      "CALENDAR_AUTH_FAILED",
    );
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new CalendarServiceError(
      "Google Calendar не върна валиден достъп.",
      502,
      "CALENDAR_AUTH_FAILED",
    );
  }
  return { token: data.access_token, config };
}

export async function listUpcomingEvents(options = {}) {
  const { token, config } = await accessToken();
  const now = options.timeMin ? new Date(options.timeMin) : new Date();
  const days = Math.min(Math.max(Number(options.days) || 7, 1), 30);
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 25);
  if (Number.isNaN(now.getTime())) {
    throw new CalendarServiceError(
      "Невалидна начална дата.",
      400,
      "INVALID_DATE",
    );
  }
  const end = new Date(now.getTime() + days * 86400000);
  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(limit),
    timeZone: "Europe/Sofia",
  });
  const apiBase = (process.env.GOOGLE_CALENDAR_API || GOOGLE_CALENDAR_API).replace(
    /\/+$/u,
    "",
  );
  const calendarId = encodeURIComponent(config.calendarId);
  const response = await fetchWithTimeout(
    `${apiBase}/calendars/${calendarId}/events?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new CalendarServiceError(
      `Google Calendar върна грешка ${response.status}.`,
      response.status,
      "CALENDAR_API_ERROR",
    );
  }
  const data = await response.json();
  return (data.items || []).map((event) => ({
    id: event.id,
    title: event.summary || "Събитие без заглавие",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    location: event.location || null,
    url: event.htmlLink || null,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
  }));
}

export function isCalendarReadRequest(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return /(?:календар|събития|ангажимент|срещи|програмата ми)/u.test(text);
}

export async function answerCalendarReadRequest(message) {
  if (!isCalendarReadRequest(message)) return null;
  const events = await listUpcomingEvents({ days: 7, limit: 10 });
  if (!events.length) {
    return "Нямаш записани събития в календара за следващите 7 дни.";
  }
  const formatter = new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    "Предстоящите ти събития са:",
    ...events.map((event) => {
      const when = event.allDay
        ? `${event.start} (цял ден)`
        : formatter.format(new Date(event.start));
      return `• ${when} — ${event.title}${event.location ? `, ${event.location}` : ""}`;
    }),
  ].join("\n");
}
