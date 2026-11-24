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
  if (!isGitHubOAuthConfigured()) {
    throw new GitHubOAuthError(
      "GitHub връзката не е конфигурирана.",
      503,
      "GITHUB_OAUTH_NOT_CONFIGURED",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isGitHubOAuthConfigured(env = process.env) {
  return Boolean(
    env.GITHUB_CLIENT_ID &&
      env.GITHUB_CLIENT_SECRET &&
      env.GITHUB_APP_ID &&
      env.GITHUB_APP_INSTALLATION_ID &&
      env.GITHUB_APP_PRIVATE_KEY,
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

export function isActiveAuthorizedGitHubSession(session, env = process.env) {
  const repository = env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  return Boolean(
    typeof session?.accessToken === "string" &&
    session.accessToken.trim() &&
    session.credentialType === "github-app-installation" &&
    session.repository?.toLowerCase() === repository.trim().toLowerCase() &&
    typeof session.expiresAt === "number" &&
    !isExpired(session.expiresAt) &&
    isAuthorizedGitHubLogin(session.login, env),
  );
}

async function createRepositoryInstallationToken(fetchImpl, env = process.env) {
  const appId = String(env.GITHUB_APP_ID || "").trim();
  const installationId = String(env.GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const repository = String(env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY).trim();
  const parts = repository.split("/");
  if (
    !/^[1-9]\d*$/u.test(appId) ||
    !/^[1-9]\d*$/u.test(installationId) ||
    typeof privateKey !== "string" ||
    !privateKey.trim() ||
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    throw new GitHubOAuthError(
      "GitHub App не е конфигурирано за едно хранилище.",
      503,
      "GITHUB_APP_NOT_CONFIGURED",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  let jwt;
  try {
    const unsigned = `${header}.${payload}`;
    jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  } catch {
    throw new GitHubOAuthError("Невалиден GitHub App ключ.", 503, "GITHUB_APP_KEY_INVALID");
  }
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "AI CORE",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [parts[1]],
        permissions: { contents: "write", pull_requests: "write", issues: "write", actions: "read", checks: "read" },
      }),
    },
  );
  if (!response.ok) {
    throw new GitHubOAuthError("GitHub App достъпът не може да бъде издаден.", 502, "GITHUB_APP_TOKEN_FAILED");
  }
  const data = await response.json();
  const expiresAt = Date.parse(data?.expires_at);
  if (
    typeof data?.token !== "string" ||
    !data.token.trim() ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !Array.isArray(data.repositories) ||
    data.repositories.length !== 1 ||
    data.repositories[0]?.full_name?.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new GitHubOAuthError("GitHub App достъпът не е ограничен до избраното хранилище.", 403, "GITHUB_APP_REPOSITORY_MISMATCH");
  }
  return { accessToken: data.token, expiresAt, repository, credentialType: "github-app-installation" };
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
  if (typeof tokens?.scope === "string" && tokens.scope.trim()) {
    throw new GitHubOAuthError("Изисква се GitHub App без широк OAuth scope.", 403, "GITHUB_APP_SCOPE_INVALID");
  }
  const login = await fetchGitHubLogin(tokens.access_token, fetchImpl);
  if (!isAuthorizedGitHubLogin(login)) {
    throw new GitHubOAuthError("Този GitHub профил няма достъп до личната система.", 403, "OWNER_GITHUB_LOGIN_REQUIRED");
  }
  const installation = await createRepositoryInstallationToken(fetchImpl);
  const id = createGitHubNonce();
  const session = {
    ...installation,
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
