import crypto from "node:crypto";
import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { logSafeError } from "../utils/safeLogging.js";
import { reservePublicAiFile } from "./publicAiBudget.js";
import { createFirestoreOAuthSessionStore } from "./firestoreOAuthSessionStore.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_REVOKE_TIMEOUT_MS = 5000;
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
let revokeTimeoutMs = GOOGLE_REVOKE_TIMEOUT_MS;

export function setFirestoreGoogleSessionStoreForTests(store) {
  firestoreSessionStoreOverride = store || null;
  firestoreSessionStore = null;
  firestoreSessionConfiguration = null;
}

export function setGoogleRevokeTimeoutForTests(milliseconds) {
  revokeTimeoutMs = milliseconds || GOOGLE_REVOKE_TIMEOUT_MS;
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
  if (backend === "firestore") {
    await getFirestoreSessionStore(env).set(id, encryptGoogleSession(session));
    return true;
  }
  return false;
}

async function loadSession(id, env = process.env) {
  if (!id) return null;
  const cached = sessions.get(id);
  if (cached) return cached;

  try {
    const backend = resolvePersistenceBackend(env);
    let payload = null;
    if (backend === "firestore") {
      payload = await getFirestoreSessionStore(env).get(id);
    } else {
      return null;
    }
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

// Extra Google services a person turns on one at a time, only when they
// use them. The first "Свържи Google" never carries them. Turning one on asks
// again for the main scopes, the extras the connection already has and the new
// one, so the new token has everything. Saving files (drive.file) and
// uploading videos (youtube.upload) each get their own token instead (see
// GOOGLE_LINKED_EXTRAS).
export const GOOGLE_EXTRA_SCOPES = Object.freeze({
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  // Only files NovariumAI itself creates (answers saved as Docs/Sheets).
  save: "https://www.googleapis.com/auth/drive.file",
  // Uploading the person's own videos to their YouTube channel.
  publish: "https://www.googleapis.com/auth/youtube.upload",
  // Reading the whole mailbox / whole Drive. Google calls these "restricted":
  // until the app passes Google's paid security audit, each person who turns
  // them on sees the "unverified app" warning. So members ask for them only
  // when they choose to, never in the first "Свържи Google".
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
  ].join(" "),
  drive: "https://www.googleapis.com/auth/drive.readonly",
});

// The main connection: exactly the set people have connected with before.
export const GOOGLE_BASE_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts",
]);

// A member's first "Свържи Google": only scopes Google can approve with its
// free check (calendar, contacts, sending mail), so it works for any number of
// people once the app is verified. Saving files (drive.file) stays its own
// add=save step: Google refuses drive.file in the same request as an already
// granted youtube.readonly (400 invalid_request).
export const GOOGLE_MEMBER_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts",
]);

// Steps whose token lives in its own session, linked from the main
// connection (`saveSessionId`, `publishSessionId`). Google refuses drive.file
// together with youtube.readonly in one grant, so they never share a token.
export const GOOGLE_LINKED_EXTRAS = Object.freeze(["save", "publish"]);
const linkField = (kind) => `${kind}SessionId`;
const LINK_FIELDS = GOOGLE_LINKED_EXTRAS.map(linkField);

export function googleConnectPath(extra = "") {
  return GOOGLE_EXTRA_SCOPES[extra] ? `/api/google/connect?add=${extra}` : "/api/google/connect";
}

// A language code such as "en" or "pt-BR"; anything else is left out.
const GOOGLE_SCREEN_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u;

// Google refuses drive.file and youtube.readonly in one grant (400
// invalid_request, "cannot be requested together"). include_granted_scopes
// would add every earlier grant to each new request, so once a person has
// turned on both YouTube and saving, every later connection would fail. So no
// request uses it: each one names exactly the scopes its token needs, and
// saving files and uploading videos always get their own token.
export function buildAuthorizationUrl(
  state,
  extras = [],
  { owner = false, loginHint = "", language = "" } = {},
) {
  const { clientId, redirectUri } = configuration();
  const names = (Array.isArray(extras) ? extras : []).filter(
    (name) => typeof name === "string" && Object.hasOwn(GOOGLE_EXTRA_SCOPES, name),
  );
  const linked = names.find((name) => GOOGLE_LINKED_EXTRAS.includes(name));
  const scopes = linked
    ? ["openid", "email", GOOGLE_EXTRA_SCOPES[linked]]
    : [
        ...(owner ? GOOGLE_BASE_SCOPES : GOOGLE_MEMBER_SCOPES),
        ...names.flatMap((name) => GOOGLE_EXTRA_SCOPES[name].split(" ")),
      ];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...new Set(scopes)].join(" "),
    access_type: "offline",
    prompt: "consent",
    // The connected Google account is picked already, so a person with two
    // accounts does not grant a step to the other one by mistake.
    ...(loginHint ? { login_hint: loginHint } : {}),
    // Google's sign-in and consent screens in the language of the page.
    ...(GOOGLE_SCREEN_LANGUAGE.test(language) ? { hl: language } : {}),
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

function grantedScopes(scope) {
  return new Set(String(scope || "").split(/\s+/u).filter(Boolean));
}

// The extra services (YouTube, whole Gmail, whole Drive) that a main
// connection's token already covers, so renewing it or adding one more service
// keeps them.
export async function grantedExtras(id) {
  const session = await loadSession(id);
  if (!session || isLinkedSession(session)) return [];
  const granted = grantedScopes(session.scope);
  return Object.entries(GOOGLE_EXTRA_SCOPES)
    .filter(
      ([name, scopes]) =>
        !GOOGLE_LINKED_EXTRAS.includes(name) &&
        scopes.split(" ").some((scope) => granted.has(scope)),
    )
    .map(([name]) => name);
}

// The step a token was granted for when it can do nothing else (save:
// drive.file, publish: youtube.upload), or "" for a main connection.
export function linkedGrantKind(scope) {
  const granted = grantedScopes(scope);
  const basic = ["openid", "email", "https://www.googleapis.com/auth/userinfo.email"];
  return (
    GOOGLE_LINKED_EXTRAS.find((kind) => {
      const own = GOOGLE_EXTRA_SCOPES[kind];
      return granted.has(own) && [...granted].every((item) => item === own || basic.includes(item));
    }) || ""
  );
}

// A token that can only save files (the add=save step), never a main
// connection.
export function isSaveOnlyGrant(scope) {
  return linkedGrantKind(scope) === "save";
}

// The Google account behind a token (the "sub" of its sign-in id_token).
// It comes straight from Google's token endpoint, so it is only read here.
function googleSubject(session) {
  try {
    const payload = String(session?.id_token || "").split(".")[1];
    if (!payload) return "";
    return String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub || "");
  } catch {
    return "";
  }
}

// Unknown counts as the same, as before tokens were compared.
function sameGoogleAccount(left, right) {
  const a = googleSubject(left);
  const b = googleSubject(right);
  return !a || !b || a === b;
}

// Which step a session's own token is for, or "" for a main connection.
function linkedKindOf(session) {
  if (GOOGLE_LINKED_EXTRAS.includes(session?.linkedKind)) return session.linkedKind;
  if (session?.saveOnly) return "save";
  return linkedGrantKind(session?.scope);
}

function isLinkedSession(session) {
  return Boolean(linkedKindOf(session));
}

// Every scope a main "Свържи Google" can ask for. Older scopes (the first
// owner set's contacts.readonly, drive.file on an old main token) are left
// out, so a renewal is never "partial" for a scope it cannot ask for.
const MAIN_CONNECT_SCOPES = new Set([
  ...GOOGLE_MEMBER_SCOPES.filter((item) => item.startsWith("https://")),
  ...Object.entries(GOOGLE_EXTRA_SCOPES)
    .filter(([name]) => !GOOGLE_LINKED_EXTRAS.includes(name))
    .flatMap(([, scopes]) => scopes.split(" ")),
]);

// A new grant replaces the old one only when it keeps every scope the old one
// had, one by one: mail with only "read" ticked is less than read + drafts.
function coversScopes(scope, previousScope) {
  const now = grantedScopes(scope);
  return [...grantedScopes(previousScope)]
    .filter((item) => MAIN_CONNECT_SCOPES.has(item))
    .every((item) => now.has(item));
}

export async function googleLoginHint(id) {
  return googleSubject(await loadSession(id));
}

// The links to step tokens can be made or changed on another server
// instance, so the stored copy decides. The cached session is updated in
// place, so a token refresh that persists it never drops a link made elsewhere.
async function withStoredLinks(id, session) {
  if (!session || resolvePersistenceBackend(process.env) !== "firestore") return session;
  try {
    const payload = await getFirestoreSessionStore().get(id);
    if (!payload) return session;
    const stored = decryptGoogleSession(payload);
    for (const field of LINK_FIELDS) {
      if (stored[field]) session[field] = stored[field];
      else delete session[field];
    }
  } catch (error) {
    logSafeError("[Google session] Link read failure", error);
  }
  return session;
}

async function loadSessionWithLink(id) {
  return withStoredLinks(id, await loadSession(id));
}

async function deleteStoredSession(id) {
  if (!id) return;
  sessions.delete(id);
  if (resolvePersistenceBackend(process.env) === "firestore") {
    await getFirestoreSessionStore().delete(id);
  }
}

// A step token (saving files, uploading videos) lives in its own session,
// linked from the main one, so the main connection keeps every other
// permission. In production the link must be stored, or the step would ask
// again after a restart.
export async function linkSaveSession(mainId, linkedId, kind = "save") {
  if (!GOOGLE_LINKED_EXTRAS.includes(kind)) return false;
  const field = linkField(kind);
  const session = await loadSessionWithLink(mainId);
  if (!session || !linkedId || linkedId === mainId) return false;
  const previous = session[field];
  // The shared session changes only once the link is stored, so a token
  // refresh running meanwhile never stores a link that did not happen.
  let persisted = false;
  try {
    persisted = await persistSession(mainId, { ...session, [field]: linkedId });
  } catch (error) {
    logSafeError("[Google session] Link persistence failure", error);
  }
  if (!persisted && requiresPersistentGoogleSessions()) return false;
  session[field] = linkedId;
  if (previous && previous !== linkedId) await deleteUnlinkedSession(previous, mainId);
  return true;
}

// Every stored session (or, without storage, every session of this
// instance), for finding which connection links a step token.
async function knownSessions(limit = 100) {
  return (await storedSessions(limit)).list;
}

// The newest stored sessions, and whether that is all of them: the store
// answers with at most `limit`, so a full answer may have left some out.
async function storedSessions(limit) {
  if (resolvePersistenceBackend(process.env) !== "firestore") {
    return { list: [...sessions.entries()], complete: true };
  }
  const stored = await getFirestoreSessionStore().listLatest(limit);
  const list = [];
  for (const { id, payload } of stored) {
    try {
      list.push([id, decryptGoogleSession(payload)]);
    } catch {
      // Unreadable sessions link nothing.
    }
  }
  return { list, complete: stored.length < limit };
}

// A step token is deleted only when no other connection still uses it
// (two devices can share one through "Възстанови").
async function deleteUnlinkedSession(linkedId, exceptId) {
  try {
    const linkedElsewhere = (await knownSessions()).some(
      ([id, session]) =>
        id !== exceptId &&
        id !== linkedId &&
        LINK_FIELDS.some((field) => session?.[field] === linkedId),
    );
    if (!linkedElsewhere) await deleteStoredSession(linkedId);
  } catch (error) {
    logSafeError("[Google session] Old step token cleanup failure", error);
  }
}

// A linked step token no longer works (its Google permission was removed or
// expired): forget it, so the step asks for a new one instead of carrying the
// dead token to every renewed connection.
export async function forgetLinkedSession(mainId, linkedId, kind = "save") {
  if (!mainId || !linkedId || mainId === linkedId || !GOOGLE_LINKED_EXTRAS.includes(kind)) {
    return false;
  }
  const field = linkField(kind);
  const session = await loadSessionWithLink(mainId);
  if (session?.[field] === linkedId) {
    const { [field]: _dropped, ...rest } = session;
    try {
      await persistSession(mainId, rest);
      delete session[field];
    } catch (error) {
      logSafeError("[Google session] Unlink persistence failure", error);
      return false;
    }
  }
  try {
    await deleteStoredSession(linkedId);
  } catch (error) {
    logSafeError("[Google session] Dead step token cleanup failure", error);
  }
  return true;
}

// A renewed main connection keeps its steps ("Запази в Google", YouTube
// upload): each step token linked to the old connection (or the old
// connection itself, when it was only a step token) is linked to the new one.
export async function carryLinkedSessions(previousId, newId) {
  const previous = await loadSessionWithLink(previousId);
  const current = await loadSession(newId);
  if (!previous || !current || previousId === newId) return;
  const previousKind = linkedKindOf(previous);
  for (const kind of GOOGLE_LINKED_EXTRAS) {
    let linkedId = previous[linkField(kind)];
    // A step token used as the connection keeps its step. An older main token
    // that itself holds drive.file (from before saving had its own token)
    // keeps saving.
    if (
      previousKind === kind ||
      (kind === "save" &&
        !previousKind &&
        !linkedId &&
        grantedScopes(previous.scope).has(GOOGLE_EXTRA_SCOPES.save))
    ) {
      linkedId = previousId;
    }
    if (!linkedId || linkedId === newId) continue;
    const linked = await loadSession(linkedId);
    // Only into the Google account that is connected now.
    if (linked && sameGoogleAccount(linked, current)) {
      await linkSaveSession(newId, linkedId, kind);
    }
  }
}

// After Google's consent. A step token (saving files, uploading videos) is
// linked beside the person's main connection, which keeps its id, also when
// the step started before this version (its scopes tell what it is). Any
// other token becomes the main connection and keeps the linked step tokens,
// unless it can do less than the connection of the same Google account it
// would replace (boxes left unticked on Google's screen): then the old
// connection stays and `partial` tells the page to ask again.
export async function finishGoogleConnection(
  tokens,
  owner,
  { previousId = null, linked = null, saving = false } = {},
) {
  const kind =
    (GOOGLE_LINKED_EXTRAS.includes(linked) ? linked : "") ||
    (saving ? "save" : "") ||
    linkedGrantKind(tokens?.scope);
  const previous = previousId ? await loadSessionWithLink(previousId) : null;
  if (kind) {
    if (previous && !sameGoogleAccount(previous, tokens)) {
      throw new GoogleDriveError(
        "Избери същия Google профил, с който е свързан NovariumAI.",
        409,
        "GOOGLE_ACCOUNT_MISMATCH",
      );
    }
    const newId = await createSession(tokens, owner, { linkedKind: kind });
    if (!previous) return { id: newId };
    if (await linkSaveSession(previousId, newId, kind)) return { id: previousId };
    await disconnectSession(newId);
    throw new GoogleDriveError(
      "Google връзката не можа да бъде запазена защитено.",
      503,
      "GOOGLE_SESSION_PERSISTENCE_FAILED",
    );
  }
  if (
    previous &&
    !isLinkedSession(previous) &&
    sameGoogleAccount(previous, tokens) &&
    !coversScopes(tokens?.scope, previous.scope)
  ) {
    return { id: previousId, partial: true };
  }
  const newId = await createSession(tokens, owner);
  if (previous) {
    try {
      await carryLinkedSessions(previousId, newId);
    } catch (error) {
      logSafeError("[Google session] Step link carry failure", error);
    }
  }
  return { id: newId };
}

export async function saveSessionFor(mainId) {
  const session = await loadSessionWithLink(mainId);
  const saveId = session?.saveSessionId;
  return saveId && (await hasSession(saveId)) ? saveId : mainId;
}

// The token that may write new files to Drive (drive.file or full drive),
// or null. Checked before paid work such as a video, so nothing is made
// that cannot be saved.
export async function fileSaveSessionFor(mainId) {
  const id = await saveSessionFor(mainId);
  const session = id ? await loadSession(id) : null;
  const granted = grantedScopes(session?.scope);
  return granted.has(GOOGLE_EXTRA_SCOPES.save) || granted.has("https://www.googleapis.com/auth/drive") ? id : null;
}

// The linked YouTube upload token, or null when it was never turned on.
export async function publishSessionFor(mainId) {
  const session = await loadSessionWithLink(mainId);
  const id = session?.publishSessionId;
  return id && (await hasSession(id)) ? id : null;
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

// Every Google connection belongs to one account. Older connections made
// before this have no account and belong to the primary owner only.
export function googleAccountKey(memoryOwnerId) {
  return crypto
    .createHash("sha256")
    .update(`google-account:${String(memoryOwnerId || "")}`)
    .digest("hex")
    .slice(0, 32);
}

function sessionOwnedBy(session, owner) {
  if (!session || !owner?.memoryOwnerId) return false;
  if (!session.accountKey) return owner.role === "owner";
  return session.accountKey === googleAccountKey(owner.memoryOwnerId);
}

export async function sessionBelongsTo(id, owner) {
  if (!id || !owner?.memoryOwnerId) return false;
  return sessionOwnedBy(await loadSession(id), owner);
}

export async function createSession(
  tokens,
  owner = null,
  { saveOnly = false, linkedKind = "" } = {},
) {
  const kind = GOOGLE_LINKED_EXTRAS.includes(linkedKind) ? linkedKind : saveOnly ? "save" : "";
  const id = createNonce();
  const session = {
    ...tokens,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    ...(owner?.memoryOwnerId
      ? {
          accountKey: googleAccountKey(owner.memoryOwnerId),
          primaryOwner: owner.role === "owner",
        }
      : {}),
    // Only one step (saving files, uploading videos): never a main
    // connection for owner tools.
    ...(kind ? { linkedKind: kind, ...(kind === "save" ? { saveOnly: true } : {}) } : {}),
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

// Removes one connection and its linked step tokens.
export async function disconnectSession(id) {
  if (!id) return;
  const session = await loadSessionWithLink(id);
  const linked = LINK_FIELDS.map((field) => session?.[field]).filter(
    (linkedId) => linkedId && linkedId !== id,
  );
  await deleteStoredSession(id);
  for (const linkedId of linked) await deleteUnlinkedSession(linkedId, id);
}

// Google keeps an app's access until it is revoked, even when the app has
// forgotten every token. Revoking one token removes NovariumAI from the
// person's Google account, with every permission it had, so the next
// "Свържи Google" shows the full consent screen again. A failed revoke
// (Google unreachable, a token that is already dead) never keeps the tokens
// stored: the person still gets disconnected here. The token is never logged.
async function revokeGoogleToken(token) {
  try {
    const response = await globalThis.fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(revokeTimeoutMs),
    });
    // 400: the token is already dead (or revoked a moment ago through
    // another token of the same grant); nothing is left to revoke.
    if (!response.ok && response.status !== 400) {
      logSafeError("[Google disconnect] Revoke failure", { status: response.status });
    }
    return response.ok;
  } catch (error) {
    // Only the error's kind (TimeoutError, TypeError) is logged, never its text.
    logSafeError("[Google disconnect] Revoke failure", error);
    return false;
  }
}

function sessionToken(session) {
  return String(session?.refresh_token || session?.access_token || "").trim();
}

// "Прекъсни връзката": every stored Google token of the person goes (older
// connections and step tokens too), so none stays stored and the next
// "Свържи Google" starts clean instead of finding an older connection.
// The tokens are found before anything is removed, and this browser's own
// connection goes last: if the store fails on the way, that connection and
// its button stay, and pressing it again finishes the job. Before that,
// NovariumAI's access is revoked at Google too.
export async function disconnectGoogleAccount(id, owner) {
  const own = new Map();
  // Google keeps one grant per Google account, and revoking any token ends
  // all of them: the Google accounts other people (or the person's other
  // NovariumAI profile) still connect here are never revoked, only forgotten.
  // When that cannot be told for sure, nothing is revoked at all.
  const otherAccounts = new Set();
  const check = { storedConnections: 0, listComplete: false, unknownElsewhere: false };
  if (owner?.memoryOwnerId) {
    const stored = await storedSessions(1000);
    check.storedConnections = stored.list.length;
    // A list cut at its limit may have left out someone else's connection.
    check.listComplete = stored.complete;
    for (const [sessionId, session] of stored.list) {
      if (sessionOwnedBy(session, owner)) {
        own.set(sessionId, session);
      } else if (sessionId !== id) {
        const account = googleSubject(session);
        // Someone else's connection with an unknown Google account could be
        // on any account.
        if (!account && sessionToken(session)) check.unknownElsewhere = true;
        otherAccounts.add(account);
      }
    }
    // This instance's memory only adds the person's own connections: with
    // storage, someone else's connection here may be a copy that another
    // server instance has already removed.
    for (const [sessionId, session] of sessions.entries()) {
      if (sessionOwnedBy(session, owner)) own.set(sessionId, session);
    }
  }
  otherAccounts.delete("");
  const canRevoke = check.listComplete && !check.unknownElsewhere;
  const current = id ? await loadSessionWithLink(id) : null;
  const mine = [current, ...own.values()].filter(Boolean);
  const accounts = new Set(mine.map(googleSubject).filter(Boolean));
  // A token whose Google account is unknown cannot be checked, so it is
  // only forgotten as well.
  const tokens = new Set(
    mine
      .filter((session) => {
        const account = googleSubject(session);
        return canRevoke && account && !otherAccounts.has(account);
      })
      .map(sessionToken)
      .filter(Boolean),
  );
  // Why a disconnect did or did not revoke at Google: counts only, never a
  // token or an account.
  console.info("[Google disconnect] Summary", {
    connections: new Set([...own.keys(), ...(current ? [id] : [])]).size,
    accounts: accounts.size,
    sharedAccounts: [...accounts].filter((account) => otherAccounts.has(account)).length,
    ...check,
    revoked: tokens.size,
  });
  await Promise.all([...tokens].map((token) => revokeGoogleToken(token)));
  own.delete(id);
  for (const sessionId of own.keys()) await deleteStoredSession(sessionId);
  if (id) await disconnectSession(id);
}

// Several checks start at once when the tools list opens; they share one
// token refresh instead of racing each other.
const refreshing = new Map();

function refreshSession(id, fetchImpl = fetch) {
  const key = String(id || "");
  if (refreshing.has(key)) return refreshing.get(key);
  const running = refreshSessionOnce(id, fetchImpl).finally(() => refreshing.delete(key));
  refreshing.set(key, running);
  return running;
}

async function refreshSessionOnce(id, fetchImpl = fetch) {
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
  await withStoredLinks(id, session);
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

function googleConnectLink(label = "Свържи Google", extra = "") {
  const url =
    process.env.GOOGLE_CONNECT_URL ||
    "https://cloudaicore.com/api/google/connect";
  if (!GOOGLE_EXTRA_SCOPES[extra]) return `[${label}](${url})`;
  return `[${label}](${url.replace(/\?.*$/u, "")}?add=${extra})`;
}

const SERVICE_EXTRA = { Gmail: "gmail", "Google Drive": "drive" };

async function googleErrorDetails(response) {
  try {
    const data = await response.json();
    const errors = Array.isArray(data?.error?.errors) ? data.error.errors : [];
    return {
      message: String(data?.error?.message || ""),
      reasons: errors.map((item) => String(item?.reason || "")).filter(Boolean),
      status: String(data?.error?.status || ""),
    };
  } catch {
    return { message: "", reasons: [], status: "" };
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
        SERVICE_EXTRA[serviceName],
      )}.`,
      403,
      "GOOGLE_SCOPE_REQUIRED",
    );
  }

  const failure = new GoogleDriveError(
    `${serviceName} временно не е достъпен (Google грешка ${response.status}).`,
    502,
    "GOOGLE_REQUEST_FAILED",
  );
  // Google's own status (for example FAILED_PRECONDITION) lets a caller tell
  // a refused write from an outage; it is an enum name, safe to log.
  if (/^[A-Z][A-Z0-9_]{1,63}$/u.test(details.status)) {
    failure.upstreamErrorStatus = details.status;
  }
  throw failure;
}

export async function hasSession(id) {
  return Boolean(await loadSession(id));
}

// The newest main connection (never a step token) that `belongs` accepts.
// With storage, the stored list decides: a connection removed on another
// server instance can still sit in this instance's memory.
async function findLatestMainSession(belongs) {
  const linkedSaves = (list) =>
    new Set(list.flatMap((session) => LINK_FIELDS.map((field) => session?.[field])).filter(Boolean));
  const usable = (id, session, saves) =>
    belongs(session) && !isLinkedSession(session) && !saves.has(id);
  const backend = resolvePersistenceBackend(process.env);
  if (backend !== "firestore") {
    const cached = [...sessions.entries()].reverse();
    const cachedSaves = linkedSaves(cached.map(([, session]) => session));
    const found = cached.find(([id, session]) => usable(id, session, cachedSaves));
    return found ? found[0] : null;
  }

  try {
    const hits = (await getFirestoreSessionStore().listLatest(100)).map(
      ({ id, payload }) => ({ _id: id, _source: payload }),
    );
    const decoded = [];
    for (const hit of hits) {
      try {
        decoded.push({ id: hit._id, session: decryptGoogleSession(hit._source) });
      } catch {
        // Ignore stale or unreadable sessions and continue fail-closed.
      }
    }
    const saves = linkedSaves([
      ...decoded.map(({ session }) => session),
      ...sessions.values(),
    ]);
    for (const { id, session } of decoded) {
      if (session?.access_token && usable(id, session, saves)) {
        if (!sessions.has(id)) sessions.set(id, session);
        return id;
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

export async function getLatestGoogleSessionId() {
  // Only the owner's main connections: a member's Google never reaches owner
  // tools, and a save-only token (drive.file) would fail every other tool.
  return findLatestMainSession((session) => session?.primaryOwner !== false);
}

// The person's own newest main connection. A connect from a new browser, or
// after the cookie expired, then keeps their services and their save token.
export async function latestMainSessionFor(owner) {
  if (!owner?.memoryOwnerId) return null;
  return findLatestMainSession((session) => sessionOwnedBy(session, owner));
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

const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3";

function youtubeConnectError() {
  const base = (process.env.GOOGLE_CONNECT_URL || "https://cloudaicore.com/api/google/connect").replace(/\?.*$/u, "");
  return new GoogleDriveError(
    `YouTube още не е разрешен. [Свържи YouTube](${base}?add=youtube).`,
    403,
    "GOOGLE_SCOPE_REQUIRED",
  );
}

async function youtubeJson(id, path, fetchImpl) {
  try {
    const response = await googleFetch(id, `${YOUTUBE_API_URL}${path}`, {}, fetchImpl, "YouTube");
    return await response.json();
  } catch (error) {
    if (error instanceof GoogleDriveError && error.code === "GOOGLE_SCOPE_REQUIRED") {
      throw youtubeConnectError();
    }
    throw error;
  }
}

const count = (value) => (value === undefined || value === null ? null : Number(value));

// The person's own YouTube channel: totals and the latest videos with their
// views, likes and comments. Read only.
export async function getYoutubeChannelSummary(id, limit = 5, fetchImpl = fetch) {
  const channels = await youtubeJson(
    id,
    "/channels?part=snippet,statistics,contentDetails&mine=true",
    fetchImpl,
  );
  const channel = Array.isArray(channels?.items) ? channels.items[0] : null;
  if (!channel) return { channel: null, videos: [] };
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  let videos = [];
  if (uploads) {
    const max = Math.min(Math.max(Number(limit) || 5, 1), 10);
    const playlist = await youtubeJson(
      id,
      `/playlistItems?part=contentDetails&maxResults=${max}&playlistId=${encodeURIComponent(uploads)}`,
      fetchImpl,
    );
    const ids = (playlist?.items || [])
      .map((item) => item?.contentDetails?.videoId)
      .filter((videoId) => /^[A-Za-z0-9_-]{6,20}$/u.test(videoId || ""));
    if (ids.length) {
      const details = await youtubeJson(
        id,
        `/videos?part=snippet,statistics&id=${ids.join(",")}`,
        fetchImpl,
      );
      videos = (details?.items || []).map((video) => ({
        id: video.id,
        title: String(video.snippet?.title || ""),
        publishedAt: video.snippet?.publishedAt || null,
        views: count(video.statistics?.viewCount),
        likes: count(video.statistics?.likeCount),
        comments: count(video.statistics?.commentCount),
        url: `https://www.youtube.com/watch?v=${video.id}`,
      }));
    }
  }
  return {
    channel: {
      id: channel.id,
      title: String(channel.snippet?.title || ""),
      subscribers: channel.statistics?.hiddenSubscriberCount ? null : count(channel.statistics?.subscriberCount),
      views: count(channel.statistics?.viewCount),
      videos: count(channel.statistics?.videoCount),
      url: `https://www.youtube.com/channel/${channel.id}`,
    },
    videos,
  };
}

const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const SAVE_KINDS = Object.freeze({
  doc: { mimeType: "application/vnd.google-apps.document", source: "text/html" },
  sheet: { mimeType: "application/vnd.google-apps.spreadsheet", source: "text/csv" },
});
const MAX_SAVE_CHARS = 200_000;

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function inlineHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, "<b>$1</b>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function tableCells(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

const isTableLine = (line) => /^\s*\|.*\|\s*$/u.test(line);
const isDividerLine = (line) => /^\s*\|?[\s:|-]+\|?\s*$/u.test(line) && line.includes("-");

// Simple Markdown to HTML, enough for Google Docs to keep headings, lists,
// bold text and tables from an answer.
export function answerToHtml(text) {
  const lines = String(text || "").split(/\r?\n/u);
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isTableLine(line) && isDividerLine(lines[index + 1] || "")) {
      closeList();
      const head = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isTableLine(lines[index])) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      out.push(
        `<table border="1"><tr>${head.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")}</tr>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`)
          .join("")}</table>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inlineHtml((bullet || numbered)[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inlineHtml(line)}</p>`);
    }
  }
  closeList();
  return `<html><head><meta charset="utf-8"></head><body>${out.join("")}</body></html>`;
}

function csvCell(value) {
  const clean = String(value).replace(/\*\*/gu, "");
  return /[",\n]/u.test(clean) ? `"${clean.replace(/"/gu, '""')}"` : clean;
}

// Every Markdown table in the answer, one after another, as CSV.
export function answerTablesToCsv(text) {
  const lines = String(text || "").split(/\r?\n/u);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableLine(lines[index]) || !isDividerLine(lines[index + 1] || "")) continue;
    if (rows.length) rows.push([]);
    rows.push(tableCells(lines[index]));
    index += 2;
    while (index < lines.length && isTableLine(lines[index])) {
      rows.push(tableCells(lines[index]));
      index += 1;
    }
  }
  return rows.length ? rows.map((row) => row.map(csvCell).join(",")).join("\n") : "";
}

// Saves an answer as a new Google Doc or Sheet in the person's own Drive.
// drive.file lets NovariumAI touch only the files it creates.
export async function saveAnswerToGoogle(
  id,
  { kind = "doc", title = "", text = "" } = {},
  fetchImpl = fetch,
) {
  const target = SAVE_KINDS[kind];
  const body = String(text || "");
  if (!target || !body.trim() || body.length > MAX_SAVE_CHARS) {
    throw new GoogleDriveError("Няма какво да се запази.", 400, "GOOGLE_SAVE_INVALID");
  }
  const content = kind === "sheet" ? answerTablesToCsv(body) : answerToHtml(body);
  if (!content) {
    throw new GoogleDriveError(
      "В отговора няма таблица за Google Таблици.",
      400,
      "GOOGLE_SAVE_NO_TABLE",
    );
  }
  const name =
    String(title || "")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .slice(0, 120) || "NovariumAI";
  const boundary = `novarium${createNonce()}`;
  const multipart = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name, mimeType: target.mimeType }),
    `--${boundary}`,
    `Content-Type: ${target.source}; charset=UTF-8`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await googleFetch(
    id,
    `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    },
    fetchImpl,
    "Google Drive",
  );
  const data = await response.json();
  return { id: data.id, name: data.name || name, url: data.webViewLink || null, kind };
}

// Saves a generated video (MP4) as a new file in the person's own Drive.
// A resumable upload, because a clip is often bigger than the 5 MB that a
// simple multipart upload allows. drive.file: only files NovariumAI creates.
export async function saveVideoToDrive(id, { name = "", bytes, mimeType = "video/mp4" } = {}, fetchImpl = fetch) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || mimeType !== "video/mp4") {
    throw new GoogleDriveError("Няма видео за запазване.", 400, "GOOGLE_SAVE_INVALID");
  }
  const fileName =
    `${String(name || "").replace(/[\u0000-\u001f\u007f/\\]/gu, " ").trim().slice(0, 100) || "NovariumAI видео"}.mp4`;
  const start = await googleFetch(
    id,
    `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify({ name: fileName, mimeType }),
    },
    fetchImpl,
    "Google Drive",
  );
  const location = start.headers?.get?.("location");
  if (!location || !location.startsWith(`${DRIVE_UPLOAD_URL}?`)) {
    throw new GoogleDriveError("Google Drive не прие видеото. Опитай пак.", 502, "GOOGLE_UPLOAD_FAILED");
  }
  const response = await googleFetch(
    id,
    location,
    { method: "PUT", headers: { "Content-Type": mimeType }, body: bytes },
    fetchImpl,
    "Google Drive",
  );
  const data = await response.json();
  return { id: data.id, name: data.name || fileName, url: data.webViewLink || null };
}

// Reads back an MP4 that NovariumAI saved in the person's Drive (drive.file).
export async function downloadOwnDriveVideo(id, fileId, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_-]+$/u.test(fileId || "")) {
    throw new GoogleDriveError("Невалиден Google Drive файл.", 400, "INVALID_FILE_ID");
  }
  const meta = await (
    await googleFetch(id, `${DRIVE_API_URL}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`, {}, fetchImpl, "Google Drive")
  ).json();
  if (meta.mimeType !== "video/mp4" || Number(meta.size) > 256 * 1024 * 1024) {
    throw new GoogleDriveError("Това не е видео от NovariumAI.", 400, "GOOGLE_NOT_VIDEO");
  }
  const response = await googleFetch(id, `${DRIVE_API_URL}/files/${encodeURIComponent(fileId)}?alt=media`, {}, fetchImpl, "Google Drive");
  return { name: String(meta.name || "").replace(/\.mp4$/iu, ""), bytes: Buffer.from(await response.arrayBuffer()) };
}

const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
export const YOUTUBE_PRIVACY = Object.freeze(["private", "unlisted", "public"]);

// Uploads a video to the person's own YouTube channel (youtube.upload).
// Google keeps uploads from apps that have not passed YouTube's API audit
// private, whatever is asked; the answer says what YouTube actually set.
export async function uploadVideoToYoutube(
  id,
  { bytes, title = "", description = "", privacy = "private" } = {},
  fetchImpl = fetch,
) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new GoogleDriveError("Няма видео за качване.", 400, "YOUTUBE_UPLOAD_INVALID");
  }
  const status = YOUTUBE_PRIVACY.includes(privacy) ? privacy : "private";
  const clean = (value, max) => String(value || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]/gu, " ").trim().slice(0, max);
  const start = await googleFetch(
    id,
    `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify({
        snippet: { title: clean(title, 100) || "NovariumAI видео", description: clean(description, 5000) },
        status: { privacyStatus: status, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      }),
    },
    fetchImpl,
    "YouTube",
  );
  const location = start.headers?.get?.("location");
  if (!location || !location.startsWith(`${YOUTUBE_UPLOAD_URL}?`)) {
    throw new GoogleDriveError("YouTube не прие видеото. Опитай пак.", 502, "YOUTUBE_UPLOAD_FAILED");
  }
  const data = await (
    await googleFetch(id, location, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes }, fetchImpl, "YouTube")
  ).json();
  return {
    id: data.id,
    url: data.id ? `https://www.youtube.com/watch?v=${data.id}` : null,
    studio: data.id ? `https://studio.youtube.com/video/${data.id}/edit` : null,
    privacy: data.status?.privacyStatus || status,
  };
}

export function isGoogleScopeMissing(error) {
  return error instanceof GoogleDriveError && error.code === "GOOGLE_SCOPE_REQUIRED";
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
  // An empty file has nothing to read; say so instead of asking a model,
  // which would only answer that it "cannot open" it.
  if (!buffer?.length || (mimeType.startsWith("text/") && !buffer.toString("utf8").trim())) {
    return `Файлът „${name}“ е празен, няма какво да се обобщи.`;
  }
  let fileContent;
  if (mimeType.startsWith("image/")) {
    fileContent = {
      type: "input_image",
      image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  } else if (mimeType.startsWith("text/")) {
    fileContent = {
      type: "input_text",
      text: `Ето цялото съдържание на файла „${name}“:\n\n${buffer.toString("utf8")}`,
    };
  } else {
    fileContent = {
      type: "input_file",
      filename: name,
      file_data: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  }
  const documentModel = process.env.OPENAI_DOCUMENT_MODEL || "gpt-4o-mini";
  // Charged like any file for members; nothing for the owner.
  await reservePublicAiFile("openai", documentModel);
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: documentModel,
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
  { to, subject = "", body, threadId } = {},
  fetchImpl = fetch,
) {
  const recipient = cleanEmail(to);
  const thread = /^[A-Za-z0-9_-]{6,64}$/u.test(String(threadId || ""))
    ? String(threadId)
    : null;
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
        message: {
          raw: Buffer.from(mime, "utf8").toString("base64url"),
          ...(thread ? { threadId: thread } : {}),
        },
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

// Sends one plain-text email straight away (gmail.send only, no draft, so it
// works without the restricted compose scope). Callers confirm first.
export function cleanGmailMessage({ to, subject = "", body } = {}) {
  const recipient = cleanEmail(to);
  const cleanBody =
    typeof body === "string" && body.trim() && body.length <= 20_000
      ? body.trim()
      : "";
  if (!cleanBody) {
    throw new GoogleDriveError(
      "Липсва валиден текст за имейла.",
      400,
      "GMAIL_MESSAGE_INVALID",
    );
  }
  return Object.freeze({
    to: recipient,
    subject: cleanHeader(subject, 500, "тема"),
    body: cleanBody,
  });
}

export async function sendGmailMessage(id, message, fetchImpl = fetch) {
  const clean = cleanGmailMessage(message);
  const mime = [
    `To: ${clean.to}`,
    `Subject: ${mimeSubject(clean.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    clean.body,
  ].join("\r\n");
  const response = await googleFetch(
    id,
    `${GMAIL_API_URL}/users/me/messages/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: Buffer.from(mime, "utf8").toString("base64url"),
      }),
    },
    fetchImpl,
    "Gmail",
  );
  const sent = await response.json();
  if (!sent?.id) {
    throw new GoogleDriveError(
      "Gmail не потвърди изпращането.",
      502,
      "GMAIL_SEND_EMPTY_RESULT",
    );
  }
  return {
    id: sent.id,
    threadId: sent.threadId || null,
    to: clean.to,
    url: `https://mail.google.com/mail/u/0/#sent/${sent.id}`,
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

// A new contact needs a name and an email or a phone. A change needs only
// what changes: the contact already has the rest.
function normalizeContactDraft({ name, email, phone } = {}, { update = false } = {}) {
  const displayName = cleanHeader(name, 300, "име", { required: !update });
  const cleanContactEmail = email ? cleanEmail(email, "имейл на контакт") : "";
  const cleanPhone = cleanHeader(phone, 80, "телефон");
  if (!cleanContactEmail && !cleanPhone && (!update || !displayName)) {
    throw new GoogleDriveError(
      update
        ? "Промяната на контакта трябва да съдържа име, имейл или телефон."
        : "Контактът трябва да има имейл или телефон.",
      400,
      "GOOGLE_CONTACT_INVALID",
    );
  }
  return { name: displayName, email: cleanContactEmail, phone: cleanPhone };
}

// Contact answers list only the contact's own values, so a linked Google
// profile's name (in no fixed order next to it) never replaces the one the
// person saved.
const CONTACT_READ = Object.freeze({
  personFields: "names,emailAddresses,phoneNumbers",
  sources: "READ_SOURCE_TYPE_CONTACT",
});

// The contact's own values of a field, without a linked profile's.
function ownItems(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const own = list.filter((item) => item.metadata?.source?.type === "CONTACT");
  return own.length ? own : list;
}

// The contact's own (and, among several, its main) value of a field. Google
// keeps no fixed order, so the main one is found by its marker.
function ownValue(items) {
  const pool = ownItems(items);
  return (
    pool.find((item) => item.metadata?.primary || item.metadata?.sourcePrimary) ||
    pool[0] ||
    {}
  );
}

// Google fills names[].displayName itself; a contact without any name keeps
// an empty name here, so callers can show the email or phone instead.
function normalizeGoogleContact(person = {}) {
  const name = ownValue(person.names);
  return {
    resourceName: person.resourceName || null,
    etag: person.etag || null,
    name:
      name.displayName ||
      name.unstructuredName ||
      [name.givenName, name.familyName].filter(Boolean).join(" ") ||
      "",
    email: ownValue(person.emailAddresses).value || "",
    phone: ownValue(person.phoneNumbers).value || "",
  };
}

// names[].displayName is output only in the People API: a contact written
// with it alone is saved without a name. unstructuredName is the free-form
// name Google stores (and splits into given and family name).
function contactNames(contact) {
  return [{ unstructuredName: contact.name }];
}

// Google answers with the contact as it saved it. A requested name missing
// from that answer means Google did not keep it: that is reported, never
// filled in from the request, so the reply and the live check both show it.
function withNameReport(contact, requestedName) {
  if (!requestedName || contact.name) return contact;
  logSafeError("[Google Contacts] Saved without the requested name", {
    code: "GOOGLE_CONTACT_NAME_NOT_SAVED",
  });
  return { ...contact, nameSaved: false };
}

// Google replaces a whole field (every email, every phone) on update. The
// new value takes the place of the contact's main one and stays the main
// one; the other values and their labels (work, home, mobile) stay.
// null: the field stays as it is.
function withMainValue(items, value, sameValue) {
  if (!value) return null;
  const list = ownItems(items).filter(
    (item) => typeof item.value === "string" && item.value,
  );
  if (list.some((item) => sameValue(item.value, value))) return null;
  if (!list.length) return [{ value }];
  const main = ownValue(list);
  // Output-only parts and the source metadata are Google's to set.
  const writable = ({ metadata, formattedType, canonicalForm, ...kept }) => kept;
  return [
    { ...writable(main), value, metadata: { sourcePrimary: true } },
    ...list.filter((item) => item !== main).map(writable),
  ];
}

const sameEmail = (left, right) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();
// Phones match by their digits ("+359 88 123 4567" is "+359881234567"); a
// number written with letters (1-800-FLOWERS) matches only as written.
const samePhone = (left, right) => {
  const digits = (value) => value.replace(/\D/gu, "");
  return digits(left) && !/\p{L}/u.test(left + right)
    ? digits(left) === digits(right)
    : left.trim().toLowerCase() === right.trim().toLowerCase();
};

export async function searchGoogleContacts(
  id,
  query,
  limit = 10,
  fetchImpl = fetch,
  { fresh = true, retryDelayMs = 1500 } = {},
) {
  const cleanQuery = cleanHeader(query, 200, "заявка за контакт", {
    required: true,
  });
  const search = async (text) => {
    const params = new URLSearchParams({
      query: text,
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
  };
  if (!fresh) return search(cleanQuery);
  // Google answers contact searches from a cache that an empty "warmup"
  // query refreshes, and asks for it before searching. The refresh can take a
  // moment, so an empty answer is tried once more after a short wait.
  await search("");
  const found = await search(cleanQuery);
  if (found.length) return found;
  if (retryDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return search(cleanQuery);
}

export async function createGoogleContact(id, draft, fetchImpl = fetch) {
  const contact = normalizeContactDraft(draft);
  const response = await googleFetch(
    id,
    `${PEOPLE_API_URL}/people:createContact?${new URLSearchParams(CONTACT_READ)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        names: contactNames(contact),
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
  return withNameReport(created, contact.name);
}

// Changes only what the request gives. The contact is read first, because
// Google replaces a whole field on update: without it one new email would
// delete every other email (and a missing phone every phone). The etag from
// when the contact was found still guards the write, so a contact changed
// since then is refused by Google instead of overwritten.
export async function updateGoogleContact(
  id,
  { resourceName, etag, ...draft } = {},
  fetchImpl = fetch,
) {
  const contact = normalizeContactDraft(draft, { update: true });
  const cleanResourceName = contactResourceName(resourceName);
  const cleanEtag = cleanHeader(etag, 200, "Google contact etag", {
    required: true,
  });
  const read = new URLSearchParams(CONTACT_READ);
  const current = await (
    await googleFetch(
      id,
      `${PEOPLE_API_URL}/${cleanResourceName}?${read}`,
      {},
      fetchImpl,
      "Google Contacts",
    )
  ).json();
  const before = normalizeGoogleContact(current);
  const changes = {};
  // The name is rewritten only when it really changes: a rewrite drops the
  // parts Google keeps apart (title, middle and phonetic names).
  if (contact.name && contact.name !== before.name) {
    changes.names = contactNames(contact);
  }
  const emails = withMainValue(current.emailAddresses, contact.email, sameEmail);
  if (emails) changes.emailAddresses = emails;
  const phones = withMainValue(current.phoneNumbers, contact.phone, samePhone);
  if (phones) changes.phoneNumbers = phones;
  const fields = Object.keys(changes);
  if (!fields.length) return { ...before, unchanged: true };

  const params = new URLSearchParams({
    updatePersonFields: fields.join(","),
    ...CONTACT_READ,
  });
  let response;
  try {
    response = await googleFetch(
      id,
      `${PEOPLE_API_URL}/${cleanResourceName}:updateContact?${params}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ etag: cleanEtag, ...changes }),
      },
      fetchImpl,
      "Google Contacts",
    );
  } catch (error) {
    // Google refuses a write with an older etag: the contact changed after
    // it was found, and it stays as it is. A new search gives the new etag.
    if (
      error?.code === "GOOGLE_REQUEST_FAILED" &&
      error.upstreamErrorStatus === "FAILED_PRECONDITION"
    ) {
      throw new GoogleDriveError(
        "Контактът е променен след търсенето. Потърси го отново и подготви промяната пак.",
        409,
        "GOOGLE_CONTACT_CHANGED",
      );
    }
    throw error;
  }
  const updated = normalizeGoogleContact(await response.json());
  if (updated.resourceName !== cleanResourceName) {
    throw new GoogleDriveError(
      "Google Contacts не потвърди промяната.",
      502,
      "GOOGLE_CONTACT_EMPTY_RESULT",
    );
  }
  return withNameReport(updated, changes.names ? contact.name : "");
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
