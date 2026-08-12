import crypto from "node:crypto";
import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { logSafeError } from "../utils/safeLogging.js";
import { createFirestoreOAuthSessionStore } from "./firestoreOAuthSessionStore.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
const PEOPLE_API_URL = "https://people.googleapis.com/v1";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CALENDAR_REMINDER_MINUTES = 28 * 24 * 60;
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
let firestoreSessionStore = null;
let firestoreSessionConfiguration = null;
let firestoreSessionStoreOverride = null;

export function setFirestoreGoogleSessionStoreForTests(store) {
  firestoreSessionStoreOverride = store || null;
  firestoreSessionStore = null;
  firestoreSessionConfiguration = null;
}

function sessionEncryptionKey() {
  const secret =
    process.env.GOOGLE_SESSION_ENCRYPTION_KEY ||
    process.env.GOOGLE_CLIENT_SECRET;
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

function getFirestoreSessionStore(env = process.env) {
  if (firestoreSessionStoreOverride) return firestoreSessionStoreOverride;
  const configuration = [
    resolveFirestoreProjectId(env),
    resolveFirestoreDatabaseId(env),
    env.FIRESTORE_GOOGLE_SESSION_COLLECTION || "",
  ].join("\0");
  if (
    !firestoreSessionStore ||
    firestoreSessionConfiguration !== configuration
  ) {
    firestoreSessionStore = createFirestoreOAuthSessionStore({
      provider: "google",
      env,
    });
    firestoreSessionConfiguration = configuration;
  }
  return firestoreSessionStore;
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

async function persistSession(id, session, env = process.env) {
  const backend = resolvePersistenceBackend(env);
  if (backend !== "firestore") return false;
  await getFirestoreSessionStore(env).set(id, encryptGoogleSession(session));
  return true;
}

async function loadSession(id, env = process.env) {
  if (!id) return null;
  const cached = sessions.get(id);
  if (cached) return cached;

  try {
    const backend = resolvePersistenceBackend(env);
    if (backend !== "firestore") return null;
    const payload = await getFirestoreSessionStore(env).get(id);
    if (!payload) return null;
    const session = decryptGoogleSession(payload);
    sessions.set(id, session);
    return session;
  } catch (error) {
    const status =
      error?.statusCode || error?.meta?.statusCode || error?.upstreamStatus;
    if (status !== 404) {
      logSafeError("[Google session] Restore failure", error);
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
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/contacts",
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
    logSafeError("[Google session] Persistence failure", error);
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
  const backend = resolvePersistenceBackend(process.env);
  if (backend !== "firestore" || !id) return;
  try {
    await getFirestoreSessionStore().delete(id);
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status !== 404) logSafeError("[Google session] Delete failure", error);
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
    logSafeError("[Google session] Refresh persistence failure", error);
    if (requiresPersistentGoogleSessions()) {
      throw new GoogleDriveError(
        "Google връзката не можа да бъде обновена защитено.",
        503,
        "GOOGLE_SESSION_PERSISTENCE_FAILED",
      );
    }
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
    const errors = Array.isArray(data?.error?.errors) ? data.error.errors : [];
    return {
      message: String(data?.error?.message || ""),
      reasons: errors.map((item) => String(item?.reason || "")).filter(Boolean),
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

export async function getLatestGoogleSessionId() {
  for (const [id] of [...sessions.entries()].reverse()) {
    if (await hasSession(id)) return id;
  }

  const backend = resolvePersistenceBackend(process.env);
  try {
    if (backend !== "firestore") return null;
    const hits = (await getFirestoreSessionStore().listLatest(100)).map(
      ({ id, payload }) => ({ _id: id, _source: payload }),
    );
    for (const hit of hits) {
      try {
        const session = decryptGoogleSession(hit._source);
        if (session?.access_token) {
          sessions.set(hit._id, session);
          return hit._id;
        }
      } catch {
        // Ignore stale or unreadable sessions and continue fail-closed.
      }
    }
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status !== 404) {
      logSafeError("[Google session] Latest session lookup failed", error);
    }
  }
  return null;
}

export function resetGoogleSessionsForTests() {
  sessions.clear();
  setFirestoreGoogleSessionStoreForTests(null);
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
      `[Google Drive file] Upstream request failed: ${response.status}`,
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

export async function searchGmailMessages(
  id,
  query = "in:anywhere",
  limit = 10,
  fetchImpl = fetch,
) {
  const maxResults = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const cleanQuery =
    typeof query === "string" && query.trim()
      ? query.trim().slice(0, 500)
      : "in:anywhere";
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    q: cleanQuery,
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

export async function listGmailMessages(id, limit = 10, fetchImpl = fetch) {
  return searchGmailMessages(id, "in:anywhere", limit, fetchImpl);
}

export async function getGmailMessage(id, messageId, fetchImpl = fetch) {
  const cleanMessageId = gmailMessageId(messageId);
  const params = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "To", "Subject", "Date"]) {
    params.append("metadataHeaders", name);
  }
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/messages/${encodeURIComponent(cleanMessageId)}?${params}`,
    {},
    fetchImpl,
    "Gmail",
  );
  const message = await response.json();
  const headers = message.payload?.headers || [];
  return {
    id: message.id,
    threadId: message.threadId || null,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject") || "(Без тема)",
    date: headerValue(headers, "Date"),
    snippet: message.snippet || "",
  };
}

export async function getGmailDraft(id, draftId, fetchImpl = fetch) {
  const cleanDraftId = gmailMessageId(draftId, "Gmail draftId");
  const params = new URLSearchParams({ format: "metadata" });
  for (const name of ["To", "Subject", "Date"]) {
    params.append("metadataHeaders", name);
  }
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/drafts/${encodeURIComponent(cleanDraftId)}?${params}`,
    {},
    fetchImpl,
    "Gmail",
  );
  const draft = await response.json();
  const headers = draft.message?.payload?.headers || [];
  if (!draft?.id || !draft?.message?.id) {
    throw new GoogleDriveError(
      "Gmail черновата не е намерена.",
      404,
      "GMAIL_DRAFT_NOT_FOUND",
    );
  }
  return {
    id: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId || null,
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject") || "(Без тема)",
  };
}

function cleanHeader(value, maxLength, label, { required = false } = {}) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (
    (required && !clean) ||
    /[\r\n]/u.test(clean) ||
    clean.length > maxLength
  ) {
    throw new GoogleDriveError(
      `Невалидно поле „${label}“ за Gmail.`,
      400,
      "GMAIL_DRAFT_INVALID",
    );
  }
  return clean;
}

function cleanEmail(value, label = "получател") {
  const email = cleanHeader(value, 320, label, { required: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new GoogleDriveError(
      `Невалиден ${label}.`,
      400,
      "GMAIL_ADDRESS_INVALID",
    );
  }
  return email;
}

function mimeSubject(value) {
  const subject = cleanHeader(value, 500, "тема");
  return /^[\x20-\x7e]*$/u.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function gmailMessageId(value, label = "Gmail идентификатор") {
  const clean = cleanHeader(value, 200, label, { required: true });
  if (!/^[A-Za-z0-9_-]+$/u.test(clean)) {
    throw new GoogleDriveError(`Невалиден ${label}.`, 400, "GMAIL_ID_INVALID");
  }
  return clean;
}

export async function createGmailDraft(
  id,
  { to, subject = "", body } = {},
  fetchImpl = fetch,
) {
  const recipient = cleanEmail(to);
  const cleanBody =
    typeof body === "string" && body.trim() && body.length <= 20_000
      ? body.trim()
      : "";
  if (!cleanBody) {
    throw new GoogleDriveError(
      "Липсва валиден текст за Gmail черновата.",
      400,
      "GMAIL_DRAFT_INVALID",
    );
  }
  const mime = [
    `To: ${recipient}`,
    `Subject: ${mimeSubject(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    cleanBody,
  ].join("\r\n");
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/drafts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { raw: Buffer.from(mime, "utf8").toString("base64url") },
      }),
    },
    fetchImpl,
    "Gmail",
  );
  const draft = await response.json();
  if (!draft?.id || !draft?.message?.id) {
    throw new GoogleDriveError(
      "Gmail не върна потвърждение за черновата.",
      502,
      "GMAIL_DRAFT_EMPTY_RESULT",
    );
  }
  return {
    id: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId || null,
    to: recipient,
    subject: cleanHeader(subject, 500, "тема"),
    url: `https://mail.google.com/mail/u/0/#drafts/${draft.message.id}`,
  };
}

export async function sendGmailDraft(id, draftId, fetchImpl = fetch) {
  const cleanDraftId = gmailMessageId(draftId, "Gmail draftId");
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/drafts/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cleanDraftId }),
    },
    fetchImpl,
    "Gmail",
  );
  const message = await response.json();
  if (!message?.id) {
    throw new GoogleDriveError(
      "Gmail не потвърди изпращането.",
      502,
      "GMAIL_SEND_EMPTY_RESULT",
    );
  }
  return {
    id: message.id,
    threadId: message.threadId || null,
    url: `https://mail.google.com/mail/u/0/#sent/${message.id}`,
  };
}

export async function trashGmailMessage(id, messageId, fetchImpl = fetch) {
  const cleanMessageId = gmailMessageId(messageId);
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/messages/${encodeURIComponent(cleanMessageId)}/trash`,
    { method: "POST" },
    fetchImpl,
    "Gmail",
  );
  const message = await response.json();
  if (message?.id !== cleanMessageId) {
    throw new GoogleDriveError(
      "Gmail не потвърди преместването в кошчето.",
      502,
      "GMAIL_TRASH_EMPTY_RESULT",
    );
  }
  return { id: message.id, trashed: true };
}

function contactResourceName(value, { optional = false } = {}) {
  const clean = cleanHeader(value, 200, "Google contact resourceName", {
    required: !optional,
  });
  if (!clean && optional) return "";
  if (!/^people\/[A-Za-z0-9_-]+$/u.test(clean)) {
    throw new GoogleDriveError(
      "Невалиден Google контакт.",
      400,
      "GOOGLE_CONTACT_INVALID",
    );
  }
  return clean;
}

function normalizeContactDraft({ name, email, phone } = {}) {
  const displayName = cleanHeader(name, 300, "име", { required: true });
  const cleanContactEmail = email ? cleanEmail(email, "имейл на контакт") : "";
  const cleanPhone = cleanHeader(phone, 80, "телефон");
  if (!cleanContactEmail && !cleanPhone) {
    throw new GoogleDriveError(
      "Контактът трябва да има имейл или телефон.",
      400,
      "GOOGLE_CONTACT_INVALID",
    );
  }
  return { name: displayName, email: cleanContactEmail, phone: cleanPhone };
}

function normalizeGoogleContact(person = {}) {
  return {
    resourceName: person.resourceName || null,
    etag: person.etag || null,
    name: person.names?.[0]?.displayName || "Контакт",
    email: person.emailAddresses?.[0]?.value || "",
    phone: person.phoneNumbers?.[0]?.value || "",
  };
}

export async function searchGoogleContacts(
  id,
  query,
  limit = 10,
  fetchImpl = fetch,
) {
  const cleanQuery = cleanHeader(query, 200, "заявка за контакт", {
    required: true,
  });
  const params = new URLSearchParams({
    query: cleanQuery,
    readMask: "names,emailAddresses,phoneNumbers",
    pageSize: String(Math.min(Math.max(Number(limit) || 10, 1), 30)),
  });
  const response = await googleFetch(
    id,
    `${PEOPLE_API_URL}/people:searchContacts?${params}`,
    {},
    fetchImpl,
    "Google Contacts",
  );
  const data = await response.json();
  return (Array.isArray(data.results) ? data.results : [])
    .map((item) => normalizeGoogleContact(item.person))
    .filter((item) => item.resourceName);
}

export async function createGoogleContact(id, draft, fetchImpl = fetch) {
  const contact = normalizeContactDraft(draft);
  const response = await googleFetch(
    id,
    `${PEOPLE_API_URL}/people:createContact`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        names: [{ displayName: contact.name }],
        ...(contact.email
          ? { emailAddresses: [{ value: contact.email }] }
          : {}),
        ...(contact.phone ? { phoneNumbers: [{ value: contact.phone }] } : {}),
      }),
    },
    fetchImpl,
    "Google Contacts",
  );
  const created = normalizeGoogleContact(await response.json());
  if (!created.resourceName) {
    throw new GoogleDriveError(
      "Google Contacts не потвърди създаването.",
      502,
      "GOOGLE_CONTACT_EMPTY_RESULT",
    );
  }
  return created;
}

export async function updateGoogleContact(
  id,
  { resourceName, etag, ...draft } = {},
  fetchImpl = fetch,
) {
  const contact = normalizeContactDraft(draft);
  const cleanResourceName = contactResourceName(resourceName);
  const cleanEtag = cleanHeader(etag, 200, "Google contact etag", {
    required: true,
  });
  const params = new URLSearchParams({
    updatePersonFields: "names,emailAddresses,phoneNumbers",
  });
  const response = await googleFetch(
    id,
    `${PEOPLE_API_URL}/${cleanResourceName}:updateContact?${params}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        etag: cleanEtag,
        names: [{ displayName: contact.name }],
        emailAddresses: contact.email ? [{ value: contact.email }] : [],
        phoneNumbers: contact.phone ? [{ value: contact.phone }] : [],
      }),
    },
    fetchImpl,
    "Google Contacts",
  );
  const updated = normalizeGoogleContact(await response.json());
  if (updated.resourceName !== cleanResourceName) {
    throw new GoogleDriveError(
      "Google Contacts не потвърди промяната.",
      502,
      "GOOGLE_CONTACT_EMPTY_RESULT",
    );
  }
  return updated;
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

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedTimestamp({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const visible = zonedParts(new Date(candidate), timeZone);
    const visibleAsUtc = Date.UTC(
      visible.year,
      visible.month - 1,
      visible.day,
      visible.hour,
      visible.minute,
      visible.second,
    );
    candidate -= visibleAsUtc - target;
  }
  return candidate;
}

function calendarEventInterval(event, timeZone) {
  if (event?.allDay && /^\d{4}-\d{2}-\d{2}$/u.test(event.start || "")) {
    const [year, month, day] = event.start.split("-").map(Number);
    const [endYear, endMonth, endDay] = /^\d{4}-\d{2}-\d{2}$/u.test(
      event.end || "",
    )
      ? event.end.split("-").map(Number)
      : [year, month, day + 1];
    return {
      start: zonedTimestamp({ year, month, day }, timeZone),
      end: zonedTimestamp(
        { year: endYear, month: endMonth, day: endDay },
        timeZone,
      ),
    };
  }
  const start = Date.parse(event?.start || "");
  const end = Date.parse(event?.end || "");
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}

export function findAvailableCalendarSlots(
  events = [],
  {
    now = new Date(),
    days = 7,
    durationMinutes = 30,
    limit = 5,
    timeZone = "Europe/Sofia",
  } = {},
) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const safeDuration = Math.min(
    Math.max(Number(durationMinutes) || 30, 15),
    240,
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTimestamp)) {
    throw new GoogleDriveError(
      "Невалиден начален момент за свободните часове.",
      400,
      "CALENDAR_SLOT_TIME_INVALID",
    );
  }
  const busy = events
    .map((event) => calendarEventInterval(event, timeZone))
    .filter(Boolean);
  const localNow = zonedParts(new Date(nowTimestamp), timeZone);
  const calendarAnchor = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day),
  );
  const slots = [];

  for (
    let offset = 0;
    offset < safeDays && slots.length < safeLimit;
    offset += 1
  ) {
    const date = new Date(calendarAnchor.getTime() + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const workStart = zonedTimestamp({ year, month, day, hour: 9 }, timeZone);
    const workEnd = zonedTimestamp({ year, month, day, hour: 18 }, timeZone);
    const firstCandidate = Math.max(workStart, nowTimestamp);
    const stepMs = 30 * 60_000;
    let candidate = Math.ceil(firstCandidate / stepMs) * stepMs;
    const durationMs = safeDuration * 60_000;

    while (candidate + durationMs <= workEnd && slots.length < safeLimit) {
      const end = candidate + durationMs;
      if (!busy.some((item) => item.start < end && item.end > candidate)) {
        slots.push(
          Object.freeze({
            start: new Date(candidate).toISOString(),
            end: new Date(end).toISOString(),
            durationMinutes: safeDuration,
            timeZone,
          }),
        );
      }
      candidate += stepMs;
    }
  }
  return Object.freeze(slots);
}

export async function suggestGoogleCalendarSlots(
  id,
  options = {},
  fetchImpl = fetch,
) {
  const events = await listGoogleCalendarEvents(
    id,
    options.days,
    50,
    fetchImpl,
  );
  return findAvailableCalendarSlots(events, options);
}

export async function createGoogleCalendarEvent(id, event, fetchImpl = fetch) {
  const hasReminder = event.reminderMinutes !== undefined;
  if (
    hasReminder &&
    (!Number.isInteger(event.reminderMinutes) ||
      event.reminderMinutes < 0 ||
      event.reminderMinutes > MAX_CALENDAR_REMINDER_MINUTES)
  ) {
    throw new GoogleDriveError(
      "Календарното напомняне е извън разрешения период.",
      400,
      "CALENDAR_REMINDER_OFFSET_INVALID",
    );
  }
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
        ...(hasReminder
          ? {
              reminders: {
                useDefault: false,
                overrides: [
                  { method: "popup", minutes: event.reminderMinutes },
                ],
              },
            }
          : {}),
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
    ...(hasReminder ? { reminderMinutes: event.reminderMinutes } : {}),
  };
}
