import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDriveFile,
  buildAuthorizationUrl,
  createGmailDraft,
  createGoogleContact,
  createGoogleCalendarEvent,
  createSession,
  decryptGoogleSession,
  downloadDriveFile,
  encryptGoogleSession,
  findAvailableCalendarSlots,
  listGmailMessages,
  listGoogleCalendarEvents,
  listDriveFiles,
  requiresPersistentGoogleSessions,
  searchGmailMessages,
  searchGoogleContacts,
  updateGoogleContact,
} from "../src/services/googleDriveService.js";

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("lists all supported Drive file types", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  let requestedUrl = "";
  const files = await listDriveFiles(sessionId, async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      files: [{ id: "one", name: "Test", mimeType: "application/pdf" }],
    });
  });
  assert.equal(files.length, 1);
  const query = new URL(requestedUrl).searchParams.get("q");
  assert.match(query, /application\/pdf/);
  assert.match(query, /vnd\.google-apps\.document/);
  assert.match(query, /wordprocessingml\.document/);
  assert.match(query, /spreadsheetml\.sheet/);
  assert.match(query, /image\/jpeg/);
});

test("exports Google Docs as PDF before analysis", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const urls = [];
  const file = await downloadDriveFile(sessionId, "valid_id", async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return jsonResponse({
        id: "valid_id",
        name: "Документ",
        mimeType: "application/vnd.google-apps.document",
      });
    }
    return new Response(Buffer.from("pdf-data"), { status: 200 });
  });
  assert.equal(file.name, "Документ.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.match(urls[1], /\/export\?mimeType=application%2Fpdf/);
});

test("exports Google Sheets as CSV before analysis", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const urls = [];
  const file = await downloadDriveFile(sessionId, "sheet_id", async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return jsonResponse({
        id: "sheet_id",
        name: "Таблица",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
    }
    return new Response("Име,Сума\nТест,10", { status: 200 });
  });
  assert.equal(file.name, "Таблица.csv");
  assert.equal(file.mimeType, "text/csv");
  assert.match(urls[1], /\/export\?mimeType=text%2Fcsv/);
});

test("sends images to OpenAI as vision input", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody;
  const analysis = await analyzeDriveFile({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("image"),
    prompt: "",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ output_text: "Виждам снимка." });
    },
  });
  assert.equal(analysis, "Виждам снимка.");
  assert.equal(requestBody.input[0].content[0].type, "input_image");
  assert.match(
    requestBody.input[0].content[0].image_url,
    /^data:image\/jpeg;base64,/,
  );
});

test("requests Gmail messages and returns safe summaries", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const messages = await listGmailMessages(sessionId, 5, async (url) => {
    if (String(url).includes("/messages?")) {
      return jsonResponse({ messages: [{ id: "mail_1" }] });
    }
    return jsonResponse({
      id: "mail_1",
      threadId: "thread_1",
      labelIds: ["UNREAD"],
      snippet: "Кратък текст",
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "Subject", value: "Тест" },
        ],
      },
    });
  });
  assert.equal(messages[0].subject, "Тест");
  assert.equal(messages[0].unread, true);
  assert.match(messages[0].url, /mail_1$/);
});

test("requests upcoming Google Calendar events", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const events = await listGoogleCalendarEvents(sessionId, 7, 10, async () =>
    jsonResponse({
      items: [
        {
          id: "event_1",
          summary: "Среща",
          start: { dateTime: "2026-07-27T10:00:00+03:00" },
          end: { dateTime: "2026-07-27T11:00:00+03:00" },
        },
      ],
    }),
  );
  assert.equal(events[0].title, "Среща");
  assert.equal(events[0].allDay, false);
});

test("requests the explicit Drive, Gmail, Calendar and Contacts scopes", () => {
  const original = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "https://example.test/callback";
  try {
    const scope = new URL(buildAuthorizationUrl("state")).searchParams.get(
      "scope",
    );
    assert.match(scope, /calendar\.events/u);
    assert.doesNotMatch(scope, /calendar\.readonly/u);
    assert.match(scope, /gmail\.readonly/u);
    assert.match(scope, /gmail\.compose/u);
    assert.match(scope, /gmail\.modify/u);
    assert.match(scope, /contacts\.readonly/u);
    assert.match(scope, /\/auth\/contacts(?:\s|$)/u);
  } finally {
    if (original.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = original.clientId;
    if (original.clientSecret === undefined)
      delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = original.clientSecret;
    if (original.redirectUri === undefined)
      delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = original.redirectUri;
  }
});

test("searches Gmail with a bounded query and creates a reviewable draft", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const urls = [];
  const messages = await searchGmailMessages(
    sessionId,
    "from:client@example.com",
    3,
    async (url) => {
      urls.push(String(url));
      if (String(url).includes("/messages?")) {
        return jsonResponse({ messages: [{ id: "mail_1" }] });
      }
      return jsonResponse({
        id: "mail_1",
        payload: {
          headers: [
            { name: "From", value: "client@example.com" },
            { name: "Subject", value: "Проект" },
          ],
        },
      });
    },
  );
  assert.equal(messages[0].subject, "Проект");
  assert.equal(
    new URL(urls[0]).searchParams.get("q"),
    "from:client@example.com",
  );

  let request;
  const draft = await createGmailDraft(
    sessionId,
    {
      to: "client@example.com",
      subject: "Преглед на проекта",
      body: "Готова чернова за преглед.",
    },
    async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        id: "draft_1",
        message: { id: "message_1", threadId: "thread_1" },
      });
    },
  );
  assert.match(request.url, /users\/me\/drafts$/u);
  assert.equal(request.options.method, "POST");
  const encoded = JSON.parse(request.options.body).message.raw;
  const mime = Buffer.from(encoded, "base64url").toString("utf8");
  assert.match(mime, /^To: client@example\.com\r?$/mu);
  assert.match(mime, /Готова чернова за преглед/u);
  assert.equal(draft.id, "draft_1");
});

test("searches, creates and version-safely updates Google contacts", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const contacts = await searchGoogleContacts(
    sessionId,
    "Клиент",
    10,
    async (url) => {
      assert.match(String(url), /people:searchContacts/u);
      return jsonResponse({
        results: [
          {
            person: {
              resourceName: "people/person_1",
              etag: "etag-1",
              names: [{ displayName: "Клиент" }],
              emailAddresses: [{ value: "client@example.com" }],
            },
          },
        ],
      });
    },
  );
  assert.equal(contacts[0].resourceName, "people/person_1");

  let createBody;
  const created = await createGoogleContact(
    sessionId,
    { name: "Нов клиент", phone: "+359 88 123 4567" },
    async (_url, options) => {
      createBody = JSON.parse(options.body);
      return jsonResponse({
        resourceName: "people/person_2",
        etag: "etag-2",
        names: [{ displayName: "Нов клиент" }],
        phoneNumbers: [{ value: "+359 88 123 4567" }],
      });
    },
  );
  assert.equal(createBody.phoneNumbers[0].value, "+359 88 123 4567");
  assert.equal(created.resourceName, "people/person_2");

  let updateRequest;
  const updated = await updateGoogleContact(
    sessionId,
    {
      resourceName: "people/person_2",
      etag: "etag-2",
      name: "Обновен клиент",
      email: "updated@example.com",
    },
    async (url, options) => {
      updateRequest = { url: String(url), body: JSON.parse(options.body) };
      return jsonResponse({
        resourceName: "people/person_2",
        etag: "etag-3",
        names: [{ displayName: "Обновен клиент" }],
        emailAddresses: [{ value: "updated@example.com" }],
      });
    },
  );
  assert.match(updateRequest.url, /people\/person_2:updateContact/u);
  assert.equal(updateRequest.body.etag, "etag-2");
  assert.equal(updated.email, "updated@example.com");
});

test("suggests bounded working-hour slots without overlapping calendar events", () => {
  const slots = findAvailableCalendarSlots(
    [
      {
        start: "2026-08-06T10:00:00+03:00",
        end: "2026-08-06T11:00:00+03:00",
      },
    ],
    {
      now: new Date("2026-08-06T05:00:00.000Z"),
      days: 1,
      durationMinutes: 60,
      limit: 2,
      timeZone: "Europe/Sofia",
    },
  );
  assert.deepEqual(
    slots.map((slot) => [slot.start, slot.end]),
    [
      ["2026-08-06T06:00:00.000Z", "2026-08-06T07:00:00.000Z"],
      ["2026-08-06T08:00:00.000Z", "2026-08-06T09:00:00.000Z"],
    ],
  );
});

test("creates exactly one validated Google Calendar event", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  let call;
  const created = await createGoogleCalendarEvent(
    sessionId,
    {
      title: "Среща",
      start: "2026-08-05T14:30:00",
      end: "2026-08-05T15:30:00",
      timeZone: "Europe/Sofia",
      location: "Варна",
      description: "Подготовка",
    },
    async (url, options) => {
      call = { url: String(url), options };
      return jsonResponse({
        id: "event-1",
        summary: "Среща",
        start: { dateTime: "2026-08-05T14:30:00+03:00" },
        end: { dateTime: "2026-08-05T15:30:00+03:00" },
        htmlLink: "https://calendar.google.com/event?eid=safe",
      });
    },
  );

  assert.match(call.url, /calendars\/primary\/events\?sendUpdates=none/u);
  assert.equal(call.options.method, "POST");
  const body = JSON.parse(call.options.body);
  assert.equal(body.summary, "Среща");
  assert.equal(body.start.timeZone, "Europe/Sofia");
  assert.equal(body.attendees, undefined);
  assert.equal(created.id, "event-1");
});

test("creates a confirmed popup reminder without email or attendees", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  let body;
  const created = await createGoogleCalendarEvent(
    sessionId,
    {
      title: "Плащане на ток",
      start: "2026-08-05T14:30:00",
      end: "2026-08-05T14:35:00",
      timeZone: "Europe/Sofia",
      reminderMinutes: 30,
    },
    async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({
        id: "reminder-1",
        summary: "Плащане на ток",
        start: { dateTime: "2026-08-05T14:30:00+03:00" },
        end: { dateTime: "2026-08-05T14:35:00+03:00" },
      });
    },
  );

  assert.deepEqual(body.reminders, {
    useDefault: false,
    overrides: [{ method: "popup", minutes: 30 }],
  });
  assert.equal(body.attendees, undefined);
  assert.equal(created.reminderMinutes, 30);
});

test("blocks an invalid reminder before calling Google Calendar", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  let called = false;
  await assert.rejects(
    () =>
      createGoogleCalendarEvent(
        sessionId,
        {
          title: "Невалидно",
          start: "2026-08-05T14:30:00",
          end: "2026-08-05T14:35:00",
          timeZone: "Europe/Sofia",
          reminderMinutes: 40321,
        },
        async () => {
          called = true;
          return jsonResponse({});
        },
      ),
    (error) => error.code === "CALENDAR_REMINDER_OFFSET_INVALID",
  );
  assert.equal(called, false);
});

test("encrypts persisted Google sessions without exposing OAuth tokens", () => {
  const originalKey = process.env.GOOGLE_SESSION_ENCRYPTION_KEY;
  process.env.GOOGLE_SESSION_ENCRYPTION_KEY =
    "test-only-google-session-encryption-key";
  const session = {
    access_token: "private-access-token",
    refresh_token: "private-refresh-token",
    expiresAt: Date.now() + 3600000,
  };

  try {
    const encrypted = encryptGoogleSession(session);
    assert.doesNotMatch(JSON.stringify(encrypted), /private-access-token/u);
    assert.doesNotMatch(JSON.stringify(encrypted), /private-refresh-token/u);
    assert.deepEqual(decryptGoogleSession(encrypted), session);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_SESSION_ENCRYPTION_KEY;
    } else {
      process.env.GOOGLE_SESSION_ENCRYPTION_KEY = originalKey;
    }
  }
});

test("calendar permission error includes a direct reconnect link", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });

  await assert.rejects(
    () =>
      listGoogleCalendarEvents(
        sessionId,
        7,
        10,
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: "Request had insufficient authentication scopes.",
                errors: [{ reason: "forbidden" }],
              },
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    (error) => {
      assert.equal(error.code, "GOOGLE_SCOPE_REQUIRED");
      assert.match(error.message, /Разреши Google Calendar/u);
      assert.match(error.message, /\/api\/google\/connect/u);
      return true;
    },
  );
});

test("calendar disabled API is not reported as an expired connection", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });

  await assert.rejects(
    () =>
      listGoogleCalendarEvents(
        sessionId,
        7,
        10,
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                message:
                  "Google Calendar API has not been used in project or it is disabled.",
                errors: [{ reason: "accessNotConfigured" }],
              },
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    (error) => {
      assert.equal(error.code, "GOOGLE_API_DISABLED");
      assert.match(error.message, /API не е включен/u);
      assert.doesNotMatch(error.message, /ново свързване/u);
      return true;
    },
  );
});

test("requires persistent Google sessions in production", () => {
  assert.equal(
    requiresPersistentGoogleSessions({ NODE_ENV: "production" }),
    true,
  );
  assert.equal(requiresPersistentGoogleSessions({ NODE_ENV: "test" }), false);
});
