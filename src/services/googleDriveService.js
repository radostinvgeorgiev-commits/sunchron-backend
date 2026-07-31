import crypto from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SESSION_INDEX =
  process.env.GOOGLE_SESSION_INDEX || "synchron-google-sessions-v1";
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

function sessionEncryptionKey() {
  const secret =
    process.env.GOOGLE_SESSION_ENCRYPTION_KEY ||
    process.env.GOOGLE_CLIENT_SECRET;
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

export function encryptGoogleSession(session) {
  const key = sessionEncryptionKey();
  if (!key) {
    throw new GoogleDriveError(
      "Липсва ключ за защита на Google сесията.",
      503,
      "GOOGLE_SESSION_KEY_MISSING",
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

export function decryptGoogleSession(payload) {
  const key = sessionEncryptionKey();
  if (!key || payload?.version !== 1) {
    throw new GoogleDriveError(
      "Google сесията не може да бъде възстановена.",
      401,
      "GOOGLE_SESSION_INVALID",
    );
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new GoogleDriveError(
      "Google сесията не може да бъде възстановена.",
      401,
      "GOOGLE_SESSION_INVALID",
    );
  }
}

async function persistSession(id, session) {
  const client = getOpenSearchClient();
  if (!client) return false;
  await client.index({
    index: GOOGLE_SESSION_INDEX,
    id,
    body: encryptGoogleSession(session),
    refresh: true,
  });
  return true;
}

async function loadSession(id) {
  if (!id) return null;
  const cached = sessions.get(id);
  if (cached) return cached;

  const client = getOpenSearchClient();
  if (!client) return null;
  try {
    const response = await client.get({
      index: GOOGLE_SESSION_INDEX,
      id,
    });
    const payload = response.body?._source ?? response._source;
    const session = decryptGoogleSession(payload);
    sessions.set(id, session);
    return session;
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status !== 404) {
      console.error("[Google session] Restore failure:", error);
    }
    return null;
  }
}

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
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
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
      "https://www.googleapis.com/auth/calendar.events",
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

export function requiresPersistentGoogleSessions(env = process.env) {
  return env.NODE_ENV === "production";
}

export async function createSession(tokens) {
  const id = createNonce();
  const session = {
    ...tokens,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
  };
  let persisted = false;
  try {
    persisted = await persistSession(id, session);
  } catch (error) {
    console.error(
      "[Google session] Persistence failure:",
      error?.message || "unknown",
    );
  }

  if (!persisted && requiresPersistentGoogleSessions()) {
    throw new GoogleDriveError(
      "Google връзката не можа да бъде запазена защитено.",
      503,
      "GOOGLE_SESSION_PERSISTENCE_FAILED",
    );
  }

  sessions.set(id, session);
  return id;
}

export async function disconnectSession(id) {
  if (id) sessions.delete(id);
  const client = getOpenSearchClient();
  if (!id || !client) return;
  try {
    await client.delete({
      index: GOOGLE_SESSION_INDEX,
      id,
      refresh: true,
    });
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status !== 404) {
      console.error("[Google session] Delete failure:", error);
    }
  }
}

async function refreshSession(id, fetchImpl = fetch) {
  const session = await loadSession(id);
  if (!session)
    throw new GoogleDriveError(
      "Google Drive не е свързан.",
      401,
      "NOT_CONNECTED",
    );
  if (session.expiresAt > Date.now() + 60_000) return session.access_token;
  if (!session.refresh_token) {
    sessions.delete(id);
    throw new GoogleDriveError(
      "Google връзката е изтекла. Свържи я отново.",
      401,
      "TOKEN_EXPIRED",
    );
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
    throw new GoogleDriveError(
      "Google връзката е изтекла. Свържи я отново.",
      401,
      "REFRESH_FAILED",
    );
  }
  Object.assign(session, data, {
    refresh_token: data.refresh_token || session.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  try {
    await persistSession(id, session);
  } catch (error) {
    console.error("[Google session] Refresh persistence failure:", error);
  }
  return session.access_token;
}

async function driveFetch(id, path, options = {}, fetchImpl = fetch) {
  return googleFetch(
    id,
    `${DRIVE_API_URL}${path}`,
    options,
    fetchImpl,
    "Google Drive",
  );
}

function googleConnectLink(label = "Свържи Google") {
  const url =
    process.env.GOOGLE_CONNECT_URL ||
    "https://synchron.foundation/api/google/connect";
  return `[${label}](${url})`;
}

async function googleErrorDetails(response) {
  try {
    const data = await response.json();
    const errors = Array.isArray(data?.error?.errors)
      ? data.error.errors
      : [];
    return {
      message: String(data?.error?.message || ""),
      reasons: errors
        .map((item) => String(item?.reason || ""))
        .filter(Boolean),
    };
  } catch {
    return { message: "", reasons: [] };
  }
}

async function googleFetch(
  id,
  url,
  options = {},
  fetchImpl = fetch,
  serviceName = "Google",
) {
  const token = await refreshSession(id, fetchImpl);
  const response = await fetchImpl(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (response.ok) return response;

  const details = await googleErrorDetails(response);
  const reasonText = [details.message, ...details.reasons]
    .join(" ")
    .toLowerCase();

  if (response.status === 401) {
    sessions.delete(id);
    throw new GoogleDriveError(
      `Google връзката е изтекла. ${googleConnectLink("Свържи Google отново")}.`,
      401,
      "GOOGLE_RECONNECT_REQUIRED",
    );
  }

  if (response.status === 403) {
    const apiDisabled =
      /accessnotconfigured|api has not been used|api is disabled|service_disabled/u.test(
        reasonText,
      );
    if (apiDisabled) {
      throw new GoogleDriveError(
        `${serviceName} API не е включен в Google Cloud. Отвори настройката на Google проекта и включи услугата.`,
        503,
        "GOOGLE_API_DISABLED",
      );
    }
    throw new GoogleDriveError(
      `${serviceName} няма дадено разрешение. ${googleConnectLink(
        `Разреши ${serviceName}`,
      )}.`,
      403,
      "GOOGLE_SCOPE_REQUIRED",
    );
  }

  throw new GoogleDriveError(
    `${serviceName} временно не е достъпен (Google грешка ${response.status}).`,
    502,
    "GOOGLE_REQUEST_FAILED",
  );
}

export async function hasSession(id) {
  return Boolean(await loadSession(id));
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
    throw new GoogleDriveError(
      "Невалиден Google Drive файл.",
      400,
      "INVALID_FILE_ID",
    );
  }
  const metaResponse = await driveFetch(
    id,
    `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
    {},
    fetchImpl,
  );
  const meta = await metaResponse.json();
  if (!SUPPORTED_MIME_TYPES.has(meta.mimeType)) {
    throw new GoogleDriveError(
      "Този тип файл още не се поддържа.",
      415,
      "UNSUPPORTED_FILE",
    );
  }
  if (Number(meta.size || 0) > MAX_FILE_BYTES) {
    throw new GoogleDriveError(
      "Файлът трябва да бъде до 20 MB.",
      413,
      "FILE_TOO_LARGE",
    );
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
  const response = await driveFetch(id, path, {}, fetchImpl);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
    throw new GoogleDriveError(
      "Файлът трябва да бъде до 20 MB.",
      413,
      "FILE_TOO_LARGE",
    );
  }
  return { name, mimeType, buffer };
}

export async function analyzeDriveFile({
  name,
  mimeType,
  buffer,
  prompt,
  fetchImpl = fetch,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new GoogleDriveError(
      "Анализът на документи не е конфигуриран.",
      503,
      "OPENAI_NOT_CONFIGURED",
    );
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            fileContent,
            {
              type: "input_text",
              text: instruction,
            },
          ],
        },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error(
      "[Google Drive file]",
      response.status,
      data?.error?.message || "unknown error",
    );
    throw new GoogleDriveError(
      "Анализът на файла не успя.",
      502,
      "FILE_ANALYSIS_FAILED",
    );
  }
  const text =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text || "")
      .join("")
      .trim();
  if (!text)
    throw new GoogleDriveError(
      "Не получих анализ на файла.",
      502,
      "EMPTY_FILE_ANALYSIS",
    );
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
  return Promise.all(
    messages.map(async ({ id: messageId }) => {
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
        unread:
          Array.isArray(message.labelIds) &&
          message.labelIds.includes("UNREAD"),
        url: `https://mail.google.com/mail/u/0/#all/${message.id}`,
      };
    }),
  );
}

export async function listGoogleCalendarEvents(
  id,
  days = 14,
  limit = 20,
  fetchImpl = fetch,
) {
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

export async function createGoogleCalendarEvent(
  id,
  event,
  fetchImpl = fetch,
) {
  const response = await googleFetch(
    id,
    `${CALENDAR_API_URL}/calendars/primary/events?sendUpdates=none`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: event.title,
        start: { dateTime: event.start, timeZone: event.timeZone },
        end: { dateTime: event.end, timeZone: event.timeZone },
        ...(event.location ? { location: event.location } : {}),
        ...(event.description ? { description: event.description } : {}),
      }),
    },
    fetchImpl,
    "Google Calendar",
  );
  const created = await response.json();
  if (!created?.id) {
    throw new GoogleDriveError(
      "Google Calendar не върна потвърждение за записано събитие.",
      502,
      "CALENDAR_EVENT_EMPTY_RESULT",
    );
  }
  return {
    id: created.id,
    title: created.summary || event.title,
    start: created.start?.dateTime || created.start?.date || event.start,
    end: created.end?.dateTime || created.end?.date || event.end,
    location: created.location || event.location || "",
    url: created.htmlLink || "",
  };
}
