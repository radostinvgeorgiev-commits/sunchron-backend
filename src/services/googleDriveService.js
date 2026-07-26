import crypto from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const MAX_PDF_BYTES = 20 * 1024 * 1024;
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
    scope: "openid email https://www.googleapis.com/auth/drive.readonly",
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
  const token = await refreshSession(id, fetchImpl);
  const response = await fetchImpl(`${DRIVE_API_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new GoogleDriveError(
      response.status === 401 ? "Google Drive трябва да бъде свързан отново." : "Google Drive временно не е достъпен.",
      response.status === 401 ? 401 : 502,
      "DRIVE_REQUEST_FAILED",
    );
  }
  return response;
}

export function hasSession(id) {
  return Boolean(id && sessions.has(id));
}

export async function listPdfFiles(id, fetchImpl = fetch) {
  const params = new URLSearchParams({
    q: "mimeType='application/pdf' and trashed=false",
    orderBy: "modifiedTime desc",
    pageSize: "50",
    fields: "files(id,name,size,modifiedTime,webViewLink)",
  });
  const response = await driveFetch(id, `/files?${params}`, {}, fetchImpl);
  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

export async function downloadPdf(id, fileId, fetchImpl = fetch) {
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
  if (meta.mimeType !== "application/pdf") {
    throw new GoogleDriveError("Избраният файл не е PDF.", 415, "NOT_PDF");
  }
  if (Number(meta.size || 0) > MAX_PDF_BYTES) {
    throw new GoogleDriveError("PDF файлът трябва да бъде до 20 MB.", 413, "PDF_TOO_LARGE");
  }
  const response = await driveFetch(
    id,
    `/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    fetchImpl,
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_PDF_BYTES) {
    throw new GoogleDriveError("PDF файлът трябва да бъде до 20 MB.", 413, "PDF_TOO_LARGE");
  }
  return { name: meta.name || "document.pdf", buffer };
}

export async function analyzePdf({ name, buffer, prompt, fetchImpl = fetch }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new GoogleDriveError("Анализът на документи не е конфигуриран.", 503, "OPENAI_NOT_CONFIGURED");
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_file",
            filename: name,
            file_data: `data:application/pdf;base64,${buffer.toString("base64")}`,
          },
          {
            type: "input_text",
            text: prompt || "Обобщи този документ на български и посочи най-важното.",
          },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("[Google Drive PDF]", response.status, data?.error?.message || "unknown error");
    throw new GoogleDriveError("Анализът на PDF документа не успя.", 502, "PDF_ANALYSIS_FAILED");
  }
  const text = data.output_text || data.output?.flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "").join("").trim();
  if (!text) throw new GoogleDriveError("Не получих анализ на PDF документа.", 502, "EMPTY_PDF_ANALYSIS");
  return text;
}
