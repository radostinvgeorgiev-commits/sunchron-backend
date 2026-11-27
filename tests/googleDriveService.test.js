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
  linkSaveSession,
  saveSessionFor,
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

test("the main Google connection asks only for scopes Google's free check covers", () => {
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
    assert.match(scope, /gmail\.send/u);
    assert.match(scope, /\/auth\/contacts(?:\s|$)/u);
    // drive.file (add=save) and YouTube never share a request with each other.
    assert.doesNotMatch(scope, /drive\.file/u);
    // Restricted scopes (whole mailbox / whole Drive) are separate steps.
    assert.doesNotMatch(scope, /gmail\.readonly|gmail\.compose|gmail\.modify|drive\.readonly|youtube/u);
    const save = new URL(buildAuthorizationUrl("state", ["save"])).searchParams.get("scope");
    assert.equal(save, "openid email https://www.googleapis.com/auth/drive.file");
    // No request merges earlier grants: Google refuses drive.file and
    // youtube.readonly in one grant, so a merge would break every later step.
    for (const extras of [[], ["save"], ["youtube"], ["gmail"], ["drive"]]) {
      assert.equal(
        new URL(buildAuthorizationUrl("state", extras)).searchParams.get("include_granted_scopes"),
        null,
      );
    }
    // Google's screens follow the page language; anything else is left out.
    const hl = (options) =>
      new URL(buildAuthorizationUrl("state", [], options)).searchParams.get("hl");
    assert.equal(hl({ language: "en" }), "en");
    assert.equal(hl({ language: "pt-BR" }), "pt-BR");
    assert.equal(hl(), null);
    assert.equal(hl({ language: 'en"><script>' }), null);
    // One more service asks again for the main scopes plus that service.
    const youtube = new URL(buildAuthorizationUrl("state", ["youtube"])).searchParams.get("scope");
    assert.equal(youtube, `${scope} https://www.googleapis.com/auth/youtube.readonly`);
    // drive.file never shares a request with anything else.
    const mixed = new URL(buildAuthorizationUrl("state", ["youtube", "save"])).searchParams.get("scope");
    assert.equal(mixed, "openid email https://www.googleapis.com/auth/drive.file");
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
  let createUrl;
  const created = await createGoogleContact(
    sessionId,
    { name: "Нов клиент", phone: "+359 88 123 4567" },
    async (url, options) => {
      createUrl = new URL(String(url));
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
  // displayName is output only in the People API; the name is written as
  // unstructuredName, otherwise Google saves the contact without a name.
  assert.deepEqual(createBody.names, [{ unstructuredName: "Нов клиент" }]);
  // Google answers with the contact's own values only.
  assert.equal(createUrl.searchParams.get("personFields"), "names,emailAddresses,phoneNumbers");
  assert.equal(createUrl.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
  assert.equal(created.resourceName, "people/person_2");
  assert.equal(created.name, "Нов клиент");
  assert.equal(created.nameSaved, undefined);

  const requests = [];
  const updated = await updateGoogleContact(
    sessionId,
    {
      resourceName: "people/person_2",
      etag: "etag-2",
      name: "Обновен клиент",
      email: "updated@example.com",
    },
    async (url, options = {}) => {
      requests.push({
        url: new URL(String(url)),
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (!options.method) {
        return jsonResponse({
          resourceName: "people/person_2",
          etag: "etag-2",
          names: [{ displayName: "Нов клиент" }],
          phoneNumbers: [{ value: "+359 88 123 4567", type: "mobile" }],
        });
      }
      return jsonResponse({
        resourceName: "people/person_2",
        etag: "etag-3",
        names: [{ displayName: "Обновен клиент" }],
        emailAddresses: [{ value: "updated@example.com" }],
        phoneNumbers: [{ value: "+359 88 123 4567", type: "mobile" }],
      });
    },
  );
  // The contact is read first, then only the changed fields are written.
  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url.pathname.split("/").pop()}`),
    ["GET person_2", "PATCH person_2:updateContact"],
  );
  // Google refuses a contact read without personFields.
  assert.equal(requests[0].url.searchParams.get("personFields"), "names,emailAddresses,phoneNumbers");
  assert.equal(requests[0].url.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
  const update = requests[1];
  assert.equal(update.url.searchParams.get("updatePersonFields"), "names,emailAddresses");
  assert.equal(update.body.etag, "etag-2");
  assert.deepEqual(update.body.names, [{ unstructuredName: "Обновен клиент" }]);
  assert.deepEqual(update.body.emailAddresses, [{ value: "updated@example.com" }]);
  // The phone was not part of the change, so it is neither sent nor cleared.
  assert.equal("phoneNumbers" in update.body, false);
  assert.equal(updated.email, "updated@example.com");
  assert.equal(updated.phone, "+359 88 123 4567");
});

test("a contact change keeps the contact's other emails and phones and its unchanged name", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const own = (extra = {}) => ({ source: { type: "CONTACT" }, ...extra });
  const requests = [];
  await updateGoogleContact(
    sessionId,
    {
      resourceName: "people/person_7",
      etag: "etag-7",
      name: "Иван Петров",
      email: "new@firma.bg",
      phone: "+359 88 111 1111",
    },
    async (url, options = {}) => {
      requests.push({ method: options.method || "GET", url: new URL(String(url)), body: options.body });
      if (!options.method) {
        return jsonResponse({
          resourceName: "people/person_7",
          etag: "etag-7",
          names: [{ displayName: "Иван Петров", honorificPrefix: "Д-р", metadata: own({ primary: true }) }],
          emailAddresses: [
            { value: "home@example.com", type: "home", formattedType: "Home", metadata: own() },
            { value: "old@firma.bg", type: "work", formattedType: "Work", metadata: own({ primary: true }) },
          ],
          phoneNumbers: [
            { value: "+359881111111", canonicalForm: "+359881111111", type: "mobile", metadata: own({ primary: true }) },
            { value: "+359 2 222 2222", type: "work", metadata: own() },
          ],
        });
      }
      return jsonResponse({ resourceName: "people/person_7", etag: "etag-8" });
    },
  );
  const update = requests.find(({ method }) => method === "PATCH");
  const body = JSON.parse(update.body);
  // Only the email changes: the name is the same and the phone is already
  // there (written differently), so neither is rewritten.
  assert.equal(update.url.searchParams.get("updatePersonFields"), "emailAddresses");
  assert.equal("names" in body, false);
  assert.equal("phoneNumbers" in body, false);
  // The main email is replaced with its label and stays the main one (Google
  // keeps no order, so it is marked); the other one stays as it was.
  assert.deepEqual(body.emailAddresses, [
    { value: "new@firma.bg", type: "work", metadata: { sourcePrimary: true } },
    { value: "home@example.com", type: "home" },
  ]);
});

test("a contact change reports a new name Google did not keep, and a contact changed since it was found", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const current = {
    resourceName: "people/person_12",
    etag: "etag-12",
    names: [{ displayName: "Старо име" }],
    phoneNumbers: [{ value: "+359 88 000 0001" }],
  };
  const renamed = await updateGoogleContact(
    sessionId,
    { resourceName: "people/person_12", etag: "etag-12", name: "Ново име" },
    async (_url, options = {}) =>
      jsonResponse(
        options.method
          ? { resourceName: "people/person_12", etag: "etag-13", phoneNumbers: current.phoneNumbers }
          : current,
      ),
  );
  assert.equal(renamed.name, "");
  assert.equal(renamed.nameSaved, false);

  // Someone changed the contact after the search: Google refuses the old
  // etag, and the person is told to search again instead of "Google is down".
  await assert.rejects(
    () =>
      updateGoogleContact(
        sessionId,
        { resourceName: "people/person_12", etag: "etag-12", phone: "+359 88 000 0002" },
        async (_url, options = {}) =>
          options.method
            ? new Response(
                JSON.stringify({
                  error: {
                    code: 400,
                    message: "Request person.etag is different than the current person.etag.",
                    status: "FAILED_PRECONDITION",
                  },
                }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              )
            : jsonResponse(current),
      ),
    (error) => error.code === "GOOGLE_CONTACT_CHANGED" && error.status === 409,
  );
});

test("a contact change with nothing new writes nothing", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const methods = [];
  const result = await updateGoogleContact(
    sessionId,
    { resourceName: "people/person_8", etag: "etag-8", email: "SAME@example.com" },
    async (_url, options = {}) => {
      methods.push(options.method || "GET");
      return jsonResponse({
        resourceName: "people/person_8",
        etag: "etag-8",
        emailAddresses: [{ value: "same@example.com" }],
      });
    },
  );
  assert.deepEqual(methods, ["GET"]);
  assert.equal(result.unchanged, true);
  assert.equal(result.email, "same@example.com");
  // A change must give at least one thing to change.
  await assert.rejects(
    () => updateGoogleContact(sessionId, { resourceName: "people/person_8", etag: "etag-8" }),
    (error) => error.code === "GOOGLE_CONTACT_INVALID",
  );

  // Numbers written with letters are not the same just because their digits are.
  let written;
  await updateGoogleContact(
    sessionId,
    { resourceName: "people/person_8", etag: "etag-8", phone: "1-800-GOTJUNK" },
    async (_url, options = {}) => {
      if (options.method) written = JSON.parse(options.body);
      return jsonResponse({
        resourceName: "people/person_8",
        etag: "etag-8",
        phoneNumbers: [{ value: "1-800-FLOWERS" }],
      });
    },
  );
  assert.deepEqual(written.phoneNumbers, [
    { value: "1-800-GOTJUNK", metadata: { sourcePrimary: true } },
  ]);
});

test("a contact Google saved without its name is reported, never named from the request", async () => {
  const sessionId = await createSession({
    access_token: "token",
    expires_in: 3600,
  });
  const created = await createGoogleContact(
    sessionId,
    { name: "Reviewer Demo", email: "reviewer.demo@example.com" },
    async () =>
      jsonResponse({
        resourceName: "people/person_9",
        etag: "etag-9",
        emailAddresses: [{ value: "reviewer.demo@example.com" }],
      }),
  );
  assert.equal(created.name, "");
  assert.equal(created.nameSaved, false);
  assert.equal(created.email, "reviewer.demo@example.com");

  // When the answer also lists a linked Google profile, the contact's own
  // name (the one the person saved) is the one reported.
  const linked = await createGoogleContact(
    sessionId,
    { name: "Мама", email: "maria.ivanova@gmail.com" },
    async () =>
      jsonResponse({
        resourceName: "people/person_11",
        names: [
          { displayName: "Maria Ivanova", metadata: { source: { type: "PROFILE" } } },
          { displayName: "Мама", metadata: { primary: true, source: { type: "CONTACT" } } },
        ],
        emailAddresses: [{ value: "maria.ivanova@gmail.com" }],
      }),
  );
  assert.equal(linked.name, "Мама");
  assert.equal(linked.nameSaved, undefined);

  const found = await searchGoogleContacts(sessionId, "reviewer", 10, async () =>
    jsonResponse({
      results: [
        {
          person: {
            resourceName: "people/person_9",
            names: [{ givenName: "Reviewer", familyName: "Demo" }],
          },
        },
        {
          person: {
            resourceName: "people/person_10",
            emailAddresses: [{ value: "nameless@example.com" }],
          },
        },
      ],
    }),
  );
  assert.deepEqual(
    found.map((contact) => contact.name),
    ["Reviewer Demo", ""],
  );
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

test("an empty Drive file is reported as empty without asking a model", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  try {
    let called = false;
    const analysis = await analyzeDriveFile({
      name: "no-data.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("  \n"),
      fetchImpl: async () => {
        called = true;
        throw new Error("should not be called");
      },
    });
    assert.equal(called, false);
    assert.match(analysis, /празен/u);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("a member's first Google connection asks only for scopes Google's free check covers", async () => {
  const { buildAuthorizationUrl, GOOGLE_EXTRA_SCOPES } = await import("../src/services/googleDriveService.js");
  const saved = { ...process.env };
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "client";
  process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "secret";
  process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://example.test/api/google/callback";
  try {
    const member = new URL(buildAuthorizationUrl("s", [], { owner: false })).searchParams.get("scope");
    assert.doesNotMatch(member, /gmail\.readonly|gmail\.modify|gmail\.compose|drive\.readonly/u);
    assert.match(member, /gmail\.send/u);
    assert.match(member, /calendar\.events/u);
    assert.doesNotMatch(member, /drive\.file|youtube/u);
    const owner = new URL(buildAuthorizationUrl("s", [], { owner: true })).searchParams.get("scope");
    assert.match(owner, /gmail\.readonly/u);
    const gmail = new URL(buildAuthorizationUrl("s", ["gmail"], { owner: false })).searchParams.get("scope");
    assert.equal(gmail, `${member} ${GOOGLE_EXTRA_SCOPES.gmail}`);
  } finally {
    process.env = saved;
  }
});

test("contact search warms Google's cache first and retries once when nothing is found", async () => {
  const sessionId = await createSession({ access_token: "token", expires_in: 3600 });
  const found = { results: [{ person: { resourceName: "people/p2", names: [{ displayName: "Нов" }] } }] };
  const run = async (answerOn) => {
    const queries = [];
    const contacts = await searchGoogleContacts(
      sessionId,
      "Нов",
      10,
      async (url) => {
        queries.push(new URL(String(url)).searchParams.get("query"));
        return jsonResponse(queries.length === answerOn ? found : {});
      },
      { retryDelayMs: 0 },
    );
    return { queries, contacts };
  };
  const first = await run(2);
  assert.deepEqual(first.queries, ["", "Нов"]);
  assert.equal(first.contacts[0].resourceName, "people/p2");
  const late = await run(3);
  assert.deepEqual(late.queries, ["", "Нов", "Нов"]);
  assert.equal(late.contacts[0].resourceName, "people/p2");
  // The tools list check asks once, without the warmup.
  const queries = [];
  await searchGoogleContacts(sessionId, "a", 1, async (url) => {
    queries.push(new URL(String(url)).searchParams.get("query"));
    return jsonResponse({});
  }, { fresh: false });
  assert.deepEqual(queries, ["a"]);
});

test("the save token is linked to the main connection, which keeps its id", async () => {
  const main = await createSession({ access_token: "main", expires_in: 3600 });
  const save = await createSession({ access_token: "save", expires_in: 3600 });
  assert.equal(await saveSessionFor(main), main);
  assert.equal(await linkSaveSession(main, save), true);
  assert.equal(await saveSessionFor(main), save);
  assert.equal(await linkSaveSession("missing", save), false);
});
