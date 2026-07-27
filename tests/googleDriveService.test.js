import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDriveFile,
  createSession,
  decryptGoogleSession,
  downloadDriveFile,
  encryptGoogleSession,
  listGmailMessages,
  listGoogleCalendarEvents,
  listDriveFiles,
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
      listGoogleCalendarEvents(sessionId, 7, 10, async () =>
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
      listGoogleCalendarEvents(sessionId, 7, 10, async () =>
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
