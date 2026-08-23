import crypto from "node:crypto";
import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { getOpenSearchClient } from "../config/opensearch.js";
import { logSafeError } from "../utils/safeLogging.js";
import { createFirestoreOAuthSessionStore } from "./firestoreOAuthSessionStore.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_OAUTH_SCOPE = "public_repo";
export const DEFAULT_GITHUB_REDIRECT_URI =
  "https://cloudaicore.com/api/github/callback";
const DEFAULT_GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
const GITHUB_SESSION_INDEX =
  process.env.GITHUB_SESSION_INDEX || "synchron-github-sessions-v1";
const sessions = new Map();
let firestoreSessionStore = null;
let firestoreSessionConfiguration = null;
let firestoreSessionStoreOverride = null;

export function setFirestoreGitHubSessionStoreForTests(store) {
  firestoreSessionStoreOverride = store || null;
  firestoreSessionStore = null;
  firestoreSessionConfiguration = null;
}

export class GitHubOAuthError extends Error {
  constructor(message, status = 502, code = "GITHUB_OAUTH_ERROR") {
    super(message);
    this.name = "GitHubOAuthError";
    this.status = status;
    this.code = code;
  }
}

export function resolveGitHubRedirectUri(
  value = process.env.GITHUB_REDIRECT_URI,
) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return DEFAULT_GITHUB_REDIRECT_URI;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DEFAULT_GITHUB_REDIRECT_URI;
    }
    return candidate;
  } catch {
    return DEFAULT_GITHUB_REDIRECT_URI;
  }
}

function configuration() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = resolveGitHubRedirectUri();
  if (!clientId || !clientSecret) {
    throw new GitHubOAuthError(
      "GitHub връзката не е конфигурирана.",
      503,
      "GITHUB_OAUTH_NOT_CONFIGURED",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isGitHubOAuthConfigured() {
  return Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
  );
}

export function resolveOwnerGitHubLogin(env = process.env) {
  const explicitLogin =
    typeof env.SYNCHRON_OWNER_GITHUB_LOGIN === "string"
      ? env.SYNCHRON_OWNER_GITHUB_LOGIN.trim()
      : "";
  if (explicitLogin) return explicitLogin;

  const repository =
    typeof env.GITHUB_REPOSITORY === "string" && env.GITHUB_REPOSITORY.trim()
      ? env.GITHUB_REPOSITORY.trim()
      : DEFAULT_GITHUB_REPOSITORY;
  return repository.split("/", 1)[0];
}

export function isAuthorizedGitHubLogin(login, env = process.env) {
  return (
    typeof login === "string" &&
    login.trim().toLocaleLowerCase("en-US") ===
      resolveOwnerGitHubLogin(env).toLocaleLowerCase("en-US")
  );
}

function sessionEncryptionKey() {
  const secret =
    process.env.GITHUB_SESSION_ENCRYPTION_KEY ||
    process.env.GITHUB_CLIENT_SECRET;
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

function getFirestoreSessionStore(env = process.env) {
  if (firestoreSessionStoreOverride) return firestoreSessionStoreOverride;
  const configuration = [
    resolveFirestoreProjectId(env),
    resolveFirestoreDatabaseId(env),
    env.FIRESTORE_GITHUB_SESSION_COLLECTION || "",
  ].join("\0");
  if (
    !firestoreSessionStore ||
    firestoreSessionConfiguration !== configuration
  ) {
    firestoreSessionStore = createFirestoreOAuthSessionStore({
      provider: "github",
      env,
    });
    firestoreSessionConfiguration = configuration;
  }
  return firestoreSessionStore;
}

export function createGitHubNonce() {
  return crypto.randomBytes(32).toString("base64url");
}

export function parseGitHubCookies(header = "") {
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

export function buildGitHubAuthorizationUrl(state) {
  const { clientId, redirectUri } = configuration();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GITHUB_OAUTH_SCOPE,
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params}`;
}

export async function exchangeGitHubCode(code, fetchImpl = fetch) {
  const { clientId, clientSecret, redirectUri } = configuration();
  const response = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new GitHubOAuthError(
      "GitHub не разреши връзката. Опитай отново.",
      502,
      "GITHUB_TOKEN_EXCHANGE_FAILED",
    );
  }
  return data;
}

async function fetchGitHubLogin(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "AI CORE",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const data = await response.json();
  if (!response.ok || !data.login) {
    throw new GitHubOAuthError(
      "GitHub профилът не може да бъде проверен.",
      response.status || 502,
      "GITHUB_PROFILE_UNAVAILABLE",
    );
  }
  return data.login;
}

export function encryptGitHubSession(session) {
  const key = sessionEncryptionKey();
  if (!key) {
    throw new GitHubOAuthError(
      "Липсва ключ за защита на GitHub сесията.",
      503,
      "GITHUB_SESSION_KEY_MISSING",
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

export function decryptGitHubSession(payload) {
  const key = sessionEncryptionKey();
  if (!key || payload?.version !== 1) {
    throw new GitHubOAuthError(
      "GitHub сесията не може да бъде възстановена.",
      401,
      "GITHUB_SESSION_INVALID",
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
    throw new GitHubOAuthError(
      "GitHub сесията не може да бъде възстановена.",
      401,
      "GITHUB_SESSION_INVALID",
    );
  }
}

export function requiresPersistentGitHubSessions(env = process.env) {
  return env.NODE_ENV === "production";
}

function isExpired(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return false;
  const timestamp = Number(expiresAt);
  return !Number.isFinite(timestamp) || Date.now() >= timestamp;
}

export function isActiveAuthorizedGitHubSession(
  session,
  env = process.env,
) {
  return Boolean(
    typeof session?.accessToken === "string" &&
      session.accessToken.trim() &&
      !isExpired(session.expiresAt) &&
      isAuthorizedGitHubLogin(session.login, env),
  );
}

async function persistSession(id, session, env = process.env) {
  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    await getFirestoreSessionStore(env).set(id, encryptGitHubSession(session));
    return true;
  }
  if (backend !== "opensearch") return false;
  const client = getOpenSearchClient();
  if (!client) return false;
  await client.index({
    index: GITHUB_SESSION_INDEX,
    id,
    body: encryptGitHubSession(session),
    refresh: true,
  });
  return true;
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
    } else if (backend === "opensearch") {
      const client = getOpenSearchClient();
      if (!client) return null;
      const response = await client.get({
        index: GITHUB_SESSION_INDEX,
        id,
      });
      payload = response.body?._source ?? response._source;
    } else {
      return null;
    }
    if (!payload) return null;
    const session = decryptGitHubSession(payload);
    sessions.set(id, session);
    return session;
  } catch (error) {
    const status =
      error?.statusCode || error?.meta?.statusCode || error?.upstreamStatus;
    if (status !== 404) {
      logSafeError("[GitHub session] Restore failure", error);
    }
    return null;
  }
}

export async function createGitHubSession(tokens, fetchImpl = fetch) {
  const login = await fetchGitHubLogin(tokens.access_token, fetchImpl);
  const id = createGitHubNonce();
  const session = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in
      ? Date.now() + Number(tokens.expires_in) * 1000
      : null,
    refreshTokenExpiresAt: tokens.refresh_token_expires_in
      ? Date.now() + Number(tokens.refresh_token_expires_in) * 1000
      : null,
    login,
    createdAt: Date.now(),
  };
  try {
    const persisted = await persistSession(id, session);
    if (!persisted && requiresPersistentGitHubSessions()) {
      throw new GitHubOAuthError(
        "GitHub OAuth session storage не е конфигурирано.",
        503,
        "GITHUB_SESSION_PERSISTENCE_FAILED",
      );
    }
  } catch (error) {
    sessions.delete(id);
    logSafeError("[GitHub session] Persistence failure", error);
    throw new GitHubOAuthError(
      "GitHub връзката не можа да бъде запазена защитено.",
      503,
      "GITHUB_SESSION_PERSISTENCE_FAILED",
    );
  }
  sessions.set(id, session);
  return { id, login };
}

export async function getGitHubSession(id) {
  const session = await loadSession(id);
  return isActiveAuthorizedGitHubSession(session) ? session : null;
}

export async function hasGitHubSession(id) {
  return Boolean(await getGitHubSession(id));
}

export async function getLatestAuthorizedGitHubSession() {
  const cached = [...sessions.entries()]
    .filter(([, session]) => isActiveAuthorizedGitHubSession(session))
    .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (cached) {
    return Object.freeze({ ...cached[1], id: cached[0] });
  }

  const backend = resolvePersistenceBackend(process.env);
  let hits = [];
  if (backend === "firestore") {
    hits = (await getFirestoreSessionStore().listLatest(100)).map(
      ({ id, payload }) => ({ _id: id, _source: payload }),
    );
  } else if (backend === "opensearch") {
    const client = getOpenSearchClient();
    if (!client) return null;
    const response = await client.search({
      index: GITHUB_SESSION_INDEX,
      body: { size: 20, sort: [{ updatedAt: { order: "desc" } }] },
    });
    hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
  } else {
    return null;
  }
  for (const hit of hits) {
    try {
      const session = decryptGitHubSession(hit._source);
      if (isActiveAuthorizedGitHubSession(session)) {
        sessions.set(hit._id, session);
        return Object.freeze({ ...session, id: hit._id });
      }
    } catch {
      // Ignore stale or unreadable sessions and continue fail-closed.
    }
  }
  return null;
}

export async function disconnectGitHubSession(id) {
  if (id) sessions.delete(id);
  const backend = resolvePersistenceBackend(process.env);
  if (backend === "firestore") {
    if (id) await getFirestoreSessionStore().delete(id);
    return;
  }
  if (backend !== "opensearch") return;
  const client = getOpenSearchClient();
  if (!id || !client) return;
  try {
    await client.delete({
      index: GITHUB_SESSION_INDEX,
      id,
      refresh: true,
    });
  } catch (error) {
    const status = error?.statusCode || error?.meta?.statusCode;
    if (status !== 404) throw error;
  }
}

export function resetGitHubSessionsForTests() {
  sessions.clear();
  setFirestoreGitHubSessionStoreForTests(null);
}
