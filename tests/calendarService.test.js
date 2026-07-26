import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  answerCalendarReadRequest,
  isCalendarReadRequest,
  listUpcomingEvents,
} from "../src/services/calendarService.js";

const originalFetch = global.fetch;
const envKeys = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_API",
  "GOOGLE_TOKEN_URL",
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "client";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";
  process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_TOKEN_URL = "https://google.test/token";
  process.env.GOOGLE_CALENDAR_API = "https://google.test/calendar/v3";
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("recognizes calendar questions", () => {
  assert.equal(isCalendarReadRequest("Какво имам в календара?"), true);
  assert.equal(isCalendarReadRequest("Как работи GitHub?"), false);
});

test("reads and normalizes upcoming calendar events", async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/token")) {
      return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      items: [{
        id: "event-1",
        summary: "Среща",
        start: { dateTime: "2026-07-27T10:00:00+03:00" },
        end: { dateTime: "2026-07-27T11:00:00+03:00" },
        location: "Варна",
      }],
    }), { status: 200 });
  };

  const events = await listUpcomingEvents({
    timeMin: "2026-07-26T10:00:00+03:00",
    days: 7,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Среща");
  assert.match(calls[1].url, /calendars\/primary\/events/u);
  assert.equal(calls[1].options.headers.Authorization, "Bearer access");
});

test("answers a calendar question naturally", async () => {
  global.fetch = async (url) => {
    if (String(url).endsWith("/token")) {
      return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      items: [{
        id: "event-1",
        summary: "Преглед",
        start: { dateTime: "2026-07-27T10:00:00+03:00" },
        end: { dateTime: "2026-07-27T10:30:00+03:00" },
      }],
    }), { status: 200 });
  };
  const answer = await answerCalendarReadRequest("Какво имам в календара?");
  assert.match(answer, /Преглед/u);
});
