import crypto from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  GOOGLE_DOC,
  GOOGLE_SHEET,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "text/markdown",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const sessions = new Map();

export class GoogleDriveError extends Error {
  constructor(message, status = 502, code = "GOOGLE_DRIVE_ERROR") {
    super(message);
    this.name = "GoogleDriveError";
    this.status = status;
    this.code = code;
  }
}

export function createNonce() {
  return crypto.randomBytes(32).toString("base64url");
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return index < 0
        ? [part, ""]
        : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }),
  );
}

function configuration() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleDriveError(
      "Google Drive връзката не е конфигурирана.",
      503,
      "GOOGLE_NOT_CONFIGURED",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthorizationUrl(state) {
  const { clientId, redirectUri } = configuration();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeCode(code, fetchImpl = fetch) {
  const { clientId, clientSecret, redirectUri } = configuration();
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new GoogleDriveError(
      "Google не разреши връзката. Опитай отново.",
      502,
      "TOKEN_EXCHANGE_FAILED",
    );
  }
  return data;
}

export function createSession(tokens) {
  const id = createNonce();
  sessions.set(id, {
    ...tokens,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
  });
  return id;
}

export function disconnectSession(id) {
  if (id) sessions.delete(id);
}

async function refreshSession(id, fetchImpl = fetch) {
  const session = sessions.get(id);
  if (!session) throw new GoogleDriveError("Google Drive не е свързан.", 401, "NOT_CONNECTED");
  if (session.expiresAt > Date.now() + 60_000) return session.access_token;
  if (!session.refresh_token) {
    sessions.delete(id);
    throw new GoogleDriveError("Google връзката е изтекла. Свържи я отново.", 401, "TOKEN_EXPIRED");
  }
  const { clientId, clientSecret } = configuration();
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: session.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    sessions.delete(id);
    throw new GoogleDriveError("Google връзката е изтекла. Свържи я отново.", 401, "REFRESH_FAILED");
  }
  Object.assign(session, data, {
    refresh_token: data.refresh_token || session.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return session.access_token;
}

async function driveFetch(id, path, options = {}, fetchImpl = fetch) {
  return googleFetch(id, `${DRIVE_API_URL}${path}`, options, fetchImpl, "Google Drive");
}

async function googleFetch(id, url, options = {}, fetchImpl = fetch, serviceName = "Google") {
  const token = await refreshSession(id, fetchImpl);
  const response = await fetchImpl(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const reconnect = response.status === 401 || response.status === 403;
    throw new GoogleDriveError(
      reconnect
        ? `${serviceName} трябва да бъде разрешен чрез ново свързване.`
        : `${serviceName} временно не е достъпен.`,
      reconnect ? 401 : 502,
      "GOOGLE_REQUEST_FAILED",
    );
  }
  return response;
}

export function hasSession(id) {
  return Boolean(id && sessions.has(id));
}

export async function listDriveFiles(id, fetchImpl = fetch) {
  const mimeQuery = [...SUPPORTED_MIME_TYPES]
    .map((mimeType) => `mimeType='${mimeType}'`)
    .join(" or ");
  const params = new URLSearchParams({
    q: `(${mimeQuery}) and trashed=false`,
    orderBy: "modifiedTime desc",
    pageSize: "50",
    fields: "files(id,name,size,mimeType,modifiedTime,webViewLink)",
  });
  const response = await driveFetch(id, `/files?${params}`, {}, fetchImpl);
  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

export async function downloadDriveFile(id, fileId, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_-]+$/u.test(fileId || "")) {
    throw new GoogleDriveError("Невалиден Google Drive файл.", 400, "INVALID_FILE_ID");
  }
  const metaResponse = await driveFetch(
    id,
    `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
    {},
    fetchImpl,
  );
  const meta = await metaResponse.json();
  if (!SUPPORTED_MIME_TYPES.has(meta.mimeType)) {
    throw new GoogleDriveError("Този тип файл още не се поддържа.", 415, "UNSUPPORTED_FILE");
  }
  if (Number(meta.size || 0) > MAX_FILE_BYTES) {
    throw new GoogleDriveError("Файлът трябва да бъде до 20 MB.", 413, "FILE_TOO_LARGE");
  }
  let path = `/files/${encodeURIComponent(fileId)}?alt=media`;
  let mimeType = meta.mimeType;
  let name = meta.name || "document";
  if (meta.mimeType === GOOGLE_DOC) {
    mimeType = "application/pdf";
    name = `${name}.pdf`;
    path = `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`;
  } else if (meta.mimeType === GOOGLE_SHEET) {
    mimeType = "text/csv";
    name = `${name}.csv`;
    path = `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`;
  }
  const response = await driveFetch(
    id,
    path,
    {},
    fetchImpl,
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
    throw new GoogleDriveError("Файлът трябва да бъде до 20 MB.", 413, "FILE_TOO_LARGE");
  }
  return { name, mimeType, buffer };
}

export async function analyzeDriveFile({ name, mimeType, buffer, prompt, fetchImpl = fetch }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new GoogleDriveError("Анализът на документи не е конфигуриран.", 503, "OPENAI_NOT_CONFIGURED");
  const instruction =
    prompt || "Обобщи този файл на български и посочи най-важното.";
  let fileContent;
  if (mimeType.startsWith("image/")) {
    fileContent = {
      type: "input_image",
      image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  } else if (mimeType.startsWith("text/")) {
    fileContent = {
      type: "input_text",
      text: `Файл: ${name}\n\n${buffer.toString("utf8")}`,
    };
  } else {
    fileContent = {
      type: "input_file",
      filename: name,
      file_data: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  }
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          fileContent,
          {
            type: "input_text",
            text: instruction,
          },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("[Google Drive file]", response.status, data?.error?.message || "unknown error");
    throw new GoogleDriveError("Анализът на файла не успя.", 502, "FILE_ANALYSIS_FAILED");
  }
  const text = data.output_text || data.output?.flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "").join("").trim();
  if (!text) throw new GoogleDriveError("Не получих анализ на файла.", 502, "EMPTY_FILE_ANALYSIS");
  return text;
}

function headerValue(headers, name) {
  const header = (headers || []).find(
    (item) => String(item?.name || "").toLowerCase() === name.toLowerCase(),
  );
  return header?.value || "";
}

export async function listGmailMessages(id, limit = 10, fetchImpl = fetch) {
  const maxResults = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    q: "in:anywhere",
  });
  const listResponse = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/messages?${params}`,
    {},
    fetchImpl,
    "Gmail",
  );
  const list = await listResponse.json();
  const messages = Array.isArray(list.messages) ? list.messages : [];
  return Promise.all(messages.map(async ({ id: messageId }) => {
    const detailParams = new URLSearchParams({
      format: "metadata",
      metadataHeaders: "From",
    });
    detailParams.append("metadataHeaders", "Subject");
    detailParams.append("metadataHeaders", "Date");
    const detailResponse = await googleFetch(
      id,
      `${GMAIL_API_URL}/users/me/messages/${encodeURIComponent(messageId)}?${detailParams}`,
      {},
      fetchImpl,
      "Gmail",
    );
    const message = await detailResponse.json();
    const headers = message.payload?.headers || [];
    return {
      id: message.id,
      threadId: message.threadId,
      from: headerValue(headers, "From"),
      subject: headerValue(headers, "Subject") || "(Без тема)",
      date: headerValue(headers, "Date"),
      snippet: message.snippet || "",
      unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD"),
      url: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    };
  }));
}

export async function listGoogleCalendarEvents(id, days = 14, limit = 20, fetchImpl = fetch) {
  const timeMin = new Date();
  const safeDays = Math.min(Math.max(Number(days) || 14, 1), 30);
  const timeMax = new Date(timeMin.getTime() + safeDays * 86400000);
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(Number(limit) || 20, 1), 50)),
    timeZone: "Europe/Sofia",
  });
  const response = await googleFetch(
    id,
    `${CALENDAR_API_URL}/calendars/primary/events?${params}`,
    {},
    fetchImpl,
    "Google Calendar",
  );
  const data = await response.json();
  return (data.items || []).map((event) => ({
    id: event.id,
    title: event.summary || "Събитие без заглавие",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
    location: event.location || "",
    url: event.htmlLink || "",
  }));
}
