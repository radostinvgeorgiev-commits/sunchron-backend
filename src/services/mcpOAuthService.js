import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  resolveFirestoreDatabaseId,
  resolveFirestoreProjectId,
  resolvePersistenceBackend,
} from "../config/memoryBackend.js";
import { getOpenSearchClient } from "../config/opensearch.js";
import {
  createFirestoreMcpOAuthStore,
  isFirestoreAlreadyExists,
} from "./firestoreMcpOAuthStore.js";

export const DEFAULT_MCP_RESOURCE_URL = "https://synchron.foundation/mcp";
export const MCP_READ_SCOPE = "synchron:read";
export const MCP_AGENT_CHAT_SCOPE = "synchron:agent.chat";
export const MCP_MEMORY_WRITE_SCOPE = "synchron:memory.write";
export const MCP_TASKS_WRITE_SCOPE = "synchron:tasks.write";
export const MCP_GITHUB_WRITE_SCOPE = "synchron:github.write";
export const MCP_GOOGLE_READ_SCOPE = "synchron:google.read";
export const MCP_GOOGLE_WRITE_SCOPE = "synchron:google.write";
export const MCP_AUDIT_READ_SCOPE = "synchron:audit.read";
export const MCP_INFRASTRUCTURE_WRITE_SCOPE = "synchron:infrastructure.write";
export const MCP_OFFLINE_ACCESS_SCOPE = "offline_access";
export const MCP_SCOPES = Object.freeze([
  MCP_READ_SCOPE,
  MCP_AGENT_CHAT_SCOPE,
  MCP_MEMORY_WRITE_SCOPE,
  MCP_TASKS_WRITE_SCOPE,
  MCP_GITHUB_WRITE_SCOPE,
  MCP_GOOGLE_READ_SCOPE,
  MCP_GOOGLE_WRITE_SCOPE,
  MCP_AUDIT_READ_SCOPE,
  MCP_INFRASTRUCTURE_WRITE_SCOPE,
]);
const MCP_AUTHORIZATION_SCOPES = Object.freeze([
  ...MCP_SCOPES,
  MCP_OFFLINE_ACCESS_SCOPE,
]);
const MCP_OWNER_ONLY_SCOPES = Object.freeze([
  MCP_GITHUB_WRITE_SCOPE,
  MCP_GOOGLE_READ_SCOPE,
  MCP_GOOGLE_WRITE_SCOPE,
  MCP_AUDIT_READ_SCOPE,
  MCP_INFRASTRUCTURE_WRITE_SCOPE,
]);

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const CONSENT_TOKEN_TTL_SECONDS = 10 * 60;
const MAX_CONSUMED_TOKEN_RECORDS = 10_000;
const REPLAY_CLEANUP_INTERVAL_SECONDS = 6 * 60 * 60;
const MCP_GRANT_REVOKE_MAX_ATTEMPTS = 3;
const MCP_OAUTH_REPLAY_INDEX =
  process.env.MCP_OAUTH_REPLAY_INDEX || "synchron-mcp-oauth-replay-v1";
const MCP_OAUTH_GRANT_INDEX =
  process.env.MCP_OAUTH_GRANT_INDEX || "synchron-mcp-oauth-grants-v1";
const consumedAuthorizationCodes = new Map();
const consumedRefreshTokens = new Map();
const localMcpGrants = new Map();
let replayIndexPromise = null;
let grantIndexPromise = null;
let lastReplayCleanupAt = 0;
let activeReplayCleanup = null;
let firestoreMcpStore = null;
let firestoreMcpConfiguration = null;
let firestoreMcpStoreOverride = null;
let oauthRuntimeStatus = Object.freeze({
  authorization: "not-attempted",
  authorizationDecision: null,
  authorizationErrorCode: null,
  authorizationUpdatedAt: null,
  tokenExchange: "not-attempted",
  grantType: null,
  errorCode: null,
  updatedAt: null,
});
let openAiTunnelRuntimeStatus = Object.freeze({
  tokenExchange: "not-attempted",
  grantType: null,
  errorCode: null,
  updatedAt: null,
});

export class McpOAuthError extends Error {
  constructor(
    message,
    status = 400,
    code = "invalid_request",
    description = message,
  ) {
    super(message);
    this.name = "McpOAuthError";
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

export function setFirestoreMcpOAuthStoreForTests(store) {
  firestoreMcpStoreOverride = store || null;
  firestoreMcpStore = null;
  firestoreMcpConfiguration = null;
}

function getFirestoreMcpStore(env = process.env, override = null) {
  if (override) return override;
  if (firestoreMcpStoreOverride) return firestoreMcpStoreOverride;
  const configuration = [
    resolveFirestoreProjectId(env),
    resolveFirestoreDatabaseId(env),
    env.FIRESTORE_MCP_GRANT_COLLECTION || "",
    env.FIRESTORE_MCP_REPLAY_COLLECTION || "",
  ].join("\0");
  if (!firestoreMcpStore || firestoreMcpConfiguration !== configuration) {
    firestoreMcpStore = createFirestoreMcpOAuthStore({ env });
    firestoreMcpConfiguration = configuration;
  }
  return firestoreMcpStore;
}

function normalizeHttpsUrl(value, fallback = "") {
  try {
    const url = new URL(String(value || fallback).trim());
    if (url.protocol !== "https:") return "";
    url.hash = "";
    url.search = "";
    return url.href.replace(/\/$/u, "");
  } catch {
    return "";
  }
}

export function resolveMcpResourceUrl(env = process.env) {
  return (
    normalizeHttpsUrl(env.MCP_RESOURCE_URL) ||
    normalizeHttpsUrl(DEFAULT_MCP_RESOURCE_URL)
  );
}

function resolveOpenAiTunnelResourceUrl(env = process.env) {
  const resource = normalizeHttpsUrl(env.MCP_OPENAI_TUNNEL_RESOURCE_URL);
  if (!resource) return "";

  const url = new URL(resource);
  if (
    !/^tunnel-service\.gateway\.[a-z0-9-]+\.internal\.api\.openai\.org$/u.test(
      url.hostname,
    ) ||
    !/^\/v1\/mcp\/tunnel_[A-Za-z0-9_-]+$/u.test(url.pathname)
  ) {
    return "";
  }
  return resource;
}

function isOpenAiTunnelResourceUrl(resource, env = process.env) {
  const configuredResource = resolveOpenAiTunnelResourceUrl(env);
  return Boolean(
    configuredResource && String(resource || "") === configuredResource,
  );
}

function recordOpenAiTunnelTokenExchange(
  input,
  { tokenExchange, grantType, errorCode = null },
  env = process.env,
) {
  if (!isOpenAiTunnelResourceUrl(input?.resource, env)) return;
  openAiTunnelRuntimeStatus = Object.freeze({
    tokenExchange,
    grantType,
    errorCode,
    updatedAt: new Date().toISOString(),
  });
}

function isAllowedMcpResourceUrl(resource, env = process.env) {
  const requested = String(resource || "");
  const canonical = resolveMcpResourceUrl(env);
  const tunnel = resolveOpenAiTunnelResourceUrl(env);
  return requested === canonical || Boolean(tunnel && requested === tunnel);
}

export function resolveMcpIssuerUrl(env = process.env) {
  return new URL(resolveMcpResourceUrl(env)).origin;
}

function deriveOAuthSecret(label, source) {
  return createHash("sha256").update(`${label}\0`).update(source).digest();
}

function legacyOAuthSecret(env = process.env) {
  const source =
    typeof env.MCP_ACCESS_TOKEN === "string" ? env.MCP_ACCESS_TOKEN.trim() : "";
  if (source.length < 32) {
    throw new McpOAuthError(
      "MCP OAuth защитата не е конфигурирана.",
      503,
      "temporarily_unavailable",
    );
  }
  return deriveOAuthSecret("synchron-mcp-oauth-v1", source);
}

function dedicatedOAuthSecret(env = process.env) {
  const source =
    typeof env.MCP_OAUTH_SECRET === "string" ? env.MCP_OAUTH_SECRET.trim() : "";
  if (!source) return null;
  if (source.length < 32) {
    throw new McpOAuthError(
      "Отделният MCP OAuth ключ е невалиден.",
      503,
      "temporarily_unavailable",
    );
  }
  return deriveOAuthSecret("synchron-mcp-oauth-dedicated-v1", source);
}

function oauthSecret(env = process.env) {
  return dedicatedOAuthSecret(env) || legacyOAuthSecret(env);
}

function oauthVerificationSecrets(env = process.env) {
  const dedicated = dedicatedOAuthSecret(env);
  if (!dedicated) return [legacyOAuthSecret(env)];
  const secrets = [dedicated];
  try {
    const legacy = legacyOAuthSecret(env);
    if (!legacy.equals(dedicated)) secrets.push(legacy);
  } catch {
    // A dedicated key can run OAuth without enabling the legacy bearer.
  }
  return secrets;
}

function deriveGrantSecret(secret) {
  return createHash("sha256")
    .update(secret)
    .update("synchron-mcp-oauth-grants-v2\0")
    .digest();
}

function grantSecret(env = process.env) {
  return deriveGrantSecret(oauthSecret(env));
}

function grantVerificationSecrets(env = process.env) {
  return oauthVerificationSecrets(env).map(deriveGrantSecret);
}

function deriveConsentSecret(secret) {
  return createHash("sha256")
    .update(secret)
    .update("synchron-mcp-oauth-consent-v1\0")
    .digest();
}

function consentSecret(env = process.env) {
  return deriveConsentSecret(oauthSecret(env));
}

function consentVerificationSecrets(env = process.env) {
  return oauthVerificationSecrets(env).map(deriveConsentSecret);
}

export function getMcpOAuthSecretMode(env = process.env) {
  if (dedicatedOAuthSecret(env)) return "dedicated";
  legacyOAuthSecret(env);
  return "legacy_fallback";
}

export function isMcpOAuthConfigured(env = process.env) {
  try {
    return Boolean(resolveMcpResourceUrl(env) && oauthSecret(env));
  } catch {
    return false;
  }
}

export function getMcpProtectedResourceMetadata(env = process.env) {
  const resource = resolveMcpResourceUrl(env);
  return {
    resource,
    authorization_servers: [resolveMcpIssuerUrl(env)],
    scopes_supported: MCP_SCOPES,
  };
}

export function getMcpAuthorizationServerMetadata(env = process.env) {
  const issuer = resolveMcpIssuerUrl(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: MCP_AUTHORIZATION_SCOPES,
  };
}

export function requiredScopesForMcpTool(name) {
  if (
    [
      "talk_to_ai_core",
      "send_message",
      "read_reply",
      "list_threads",
      "read_history",
      "continue_session",
    ].includes(name)
  ) {
    return [MCP_AGENT_CHAT_SCOPE];
  }
  if (
    [
      "prepare_memory_write",
      "confirm_memory_write",
      "prepare_memory_delete",
      "confirm_memory_delete",
    ].includes(name)
  ) {
    return [MCP_MEMORY_WRITE_SCOPE];
  }
  if (
    [
      "create_task_draft",
      "add_task_note",
      "link_task_to_project",
      "prepare_task_status_change",
      "confirm_task_status_change",
    ].includes(name)
  ) {
    return [MCP_TASKS_WRITE_SCOPE];
  }
  if (
    [
      "list_google_drive_files",
      "search_gmail",
      "list_google_calendar_events",
      "suggest_calendar_slots",
      "search_google_contacts",
    ].includes(name)
  ) {
    return [MCP_GOOGLE_READ_SCOPE];
  }
  if (
    [
      "create_gmail_draft",
      "prepare_gmail_send",
      "prepare_gmail_delete",
      "confirm_google_action",
      "prepare_calendar_event",
      "confirm_calendar_event",
      "prepare_google_contact",
    ].includes(name)
  ) {
    return [MCP_GOOGLE_WRITE_SCOPE];
  }
  if (["list_action_history", "list_recent_errors"].includes(name)) {
    return [MCP_AUDIT_READ_SCOPE];
  }
  if (["prepare_github_change", "confirm_github_change"].includes(name)) {
    return [MCP_GITHUB_WRITE_SCOPE];
  }
  if (
    name === "prepare_digitalocean_www_domain" ||
    name === "confirm_digitalocean_www_domain"
  ) {
    return [MCP_INFRASTRUCTURE_WRITE_SCOPE];
  }
  return name === "prepare_github_merged_branch_cleanup" ||
    name === "confirm_github_merged_branch_cleanup"
    ? [MCP_GITHUB_WRITE_SCOPE]
    : [MCP_READ_SCOPE];
}

export function allowsAnonymousMcpTool(name) {
  return name === "get_digitalocean_app_status";
}

export function mcpToolSecuritySchemes(name) {
  const oauth2 = Object.freeze({
    type: "oauth2",
    scopes: Object.freeze(requiredScopesForMcpTool(name)),
  });
  return allowsAnonymousMcpTool(name)
    ? Object.freeze([Object.freeze({ type: "noauth" }), oauth2])
    : Object.freeze([oauth2]);
}

export function buildMcpAuthenticateChallenge(
  scopes = [MCP_READ_SCOPE],
  env = process.env,
  { error, description } = {},
) {
  const safeHeaderValue = (value) =>
    String(value).replace(/[^\x20-\x7E]|["\\]/gu, "");
  const origin = resolveMcpIssuerUrl(env);
  const values = [
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    `scope="${scopes.join(" ")}"`,
  ];
  if (error) values.push(`error="${safeHeaderValue(error)}"`);
  if (description) {
    values.push(`error_description="${safeHeaderValue(description)}"`);
  }
  return `Bearer ${values.join(", ")}`;
}

function encryptPayload(prefix, payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return `${prefix}.${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url")}`;
}

function decryptPayload(value, prefix, key) {
  if (typeof value !== "string" || !value.startsWith(`${prefix}.`)) return null;
  try {
    const data = Buffer.from(value.slice(prefix.length + 1), "base64url");
    if (data.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function decryptPayloadWithFallback(value, prefix, keys) {
  for (const key of keys) {
    const payload = decryptPayload(value, prefix, key);
    if (payload) return payload;
  }
  return null;
}

function parseScopes(value) {
  const scopes = [...new Set(String(value || MCP_READ_SCOPE).split(/\s+/u))]
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !MCP_AUTHORIZATION_SCOPES.includes(scope))
  ) {
    throw new McpOAuthError(
      "Поисканите MCP права не се поддържат.",
      400,
      "invalid_scope",
    );
  }
  return scopes;
}

function requiresOwnerRole(scopes = []) {
  return scopes.some((scope) => MCP_OWNER_ONLY_SCOPES.includes(scope));
}

function isAllowedOpenAiClientId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host === "openai.com" ||
      host.endsWith(".openai.com")
    );
  } catch {
    return false;
  }
}

function trustedChatGptClientMetadata(clientId, redirectUri) {
  try {
    const clientUrl = new URL(clientId);
    const callbackUrl = new URL(redirectUri);
    const clientSegments = clientUrl.pathname.split("/").filter(Boolean);
    const callbackSegments = callbackUrl.pathname.split("/").filter(Boolean);
    const safeSegment = (segment) =>
      /^[A-Za-z0-9._~-]+$/u.test(segment) &&
      segment !== "." &&
      segment !== "..";

    if (
      clientUrl.origin !== "https://chatgpt.com" ||
      clientUrl.search ||
      clientUrl.hash ||
      clientSegments.length < 3 ||
      clientSegments[0] !== "oauth" ||
      clientSegments.at(-1) !== "client.json" ||
      !clientSegments.slice(1, -1).every(safeSegment) ||
      callbackUrl.origin !== "https://chatgpt.com" ||
      callbackUrl.search ||
      callbackUrl.hash ||
      callbackSegments.length !== 3 ||
      callbackSegments[0] !== "connector" ||
      callbackSegments[1] !== "oauth" ||
      !/^[A-Za-z0-9_-]{6,128}$/u.test(callbackSegments[2])
    ) {
      return null;
    }

    return {
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      token_endpoint_auth_methods_supported: ["none"],
    };
  } catch {
    return null;
  }
}

export async function validateMcpAuthorizationRequest(
  input,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const resource = String(input?.resource || "");
  const clientId = String(input?.client_id || "").trim();
  const redirectUri = String(input?.redirect_uri || "").trim();
  const state = String(input?.state || "").trim();
  const codeChallenge = String(input?.code_challenge || "").trim();

  if (input?.response_type !== "code") {
    throw new McpOAuthError("Поддържа се само authorization code.");
  }
  if (!isAllowedOpenAiClientId(clientId)) {
    throw new McpOAuthError("Непознат OAuth клиент.", 400, "invalid_client");
  }
  if (!state || state.length > 1_000) {
    throw new McpOAuthError("Липсва валидно OAuth състояние.");
  }
  if (
    input?.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)
  ) {
    throw new McpOAuthError("Изисква се PKCE S256.");
  }
  if (!isAllowedMcpResourceUrl(resource, env)) {
    throw new McpOAuthError("Невалиден MCP resource.", 400, "invalid_target");
  }

  let metadata;
  try {
    const response = await fetchImpl(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("CLIENT_METADATA_UNAVAILABLE");
    metadata = await response.json();
  } catch {
    metadata = trustedChatGptClientMetadata(clientId, redirectUri);
    if (!metadata) {
      throw new McpOAuthError(
        "OAuth клиентът не може да бъде проверен.",
        400,
        "invalid_client",
      );
    }
  }

  if (
    metadata?.client_id !== clientId ||
    typeof metadata?.client_name !== "string" ||
    !metadata.client_name.trim() ||
    !Array.isArray(metadata.redirect_uris) ||
    !metadata.redirect_uris.includes(redirectUri) ||
    !(
      metadata.token_endpoint_auth_method === "none" ||
      metadata.token_endpoint_auth_methods_supported?.includes?.("none")
    )
  ) {
    throw new McpOAuthError(
      "OAuth callback адресът не е разрешен от клиента.",
      400,
      "invalid_client",
    );
  }

  return {
    clientId,
    clientName: metadata.client_name.trim(),
    redirectUri,
    state,
    codeChallenge,
    resource,
    scopes: parseScopes(input?.scope),
  };
}

export function createMcpAuthorizationCode(
  request,
  identity,
  env = process.env,
) {
  if (!identity?.id || !identity?.memoryOwnerId || !identity?.role) {
    throw new McpOAuthError("Липсва валиден AI CORE профил.", 401);
  }
  if (requiresOwnerRole(request.scopes) && identity.role !== "owner") {
    throw new McpOAuthError(
      "MCP записът е достъпен само за собственика.",
      403,
      "access_denied",
    );
  }
  const now = Math.floor(Date.now() / 1_000);
  return encryptPayload(
    "sx-code",
    {
      typ: "authorization_code",
      jti: randomBytes(18).toString("base64url"),
      grantId: randomBytes(18).toString("base64url"),
      iss: resolveMcpIssuerUrl(env),
      aud: request.resource,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      subject: String(identity.id),
      memoryOwnerId: String(identity.memoryOwnerId),
      role: String(identity.role),
      iat: now,
      exp: now + AUTHORIZATION_CODE_TTL_SECONDS,
    },
    grantSecret(env),
  );
}

function safeStringEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function consentRequest(request) {
  return {
    clientId: String(request.clientId),
    clientName: String(request.clientName || "ChatGPT"),
    redirectUri: String(request.redirectUri),
    state: String(request.state),
    codeChallenge: String(request.codeChallenge),
    resource: String(request.resource),
    scopes: [...request.scopes],
  };
}

export function createMcpConsentToken(
  request,
  identity,
  env = process.env,
  now = Math.floor(Date.now() / 1_000),
) {
  if (!identity?.id) {
    throw new McpOAuthError("Липсва валиден AI CORE профил.", 401);
  }
  return encryptPayload(
    "sx-consent",
    {
      typ: "consent",
      subject: String(identity.id),
      request: consentRequest(request),
      iat: now,
      exp: now + CONSENT_TOKEN_TTL_SECONDS,
    },
    consentSecret(env),
  );
}

export function resolveMcpConsentRequest(
  token,
  identity,
  env = process.env,
  now = Math.floor(Date.now() / 1_000),
) {
  const payload = decryptPayloadWithFallback(
    String(token || ""),
    "sx-consent",
    consentVerificationSecrets(env),
  );
  if (
    !payload ||
    payload.typ !== "consent" ||
    payload.iat > now + 60 ||
    payload.exp <= now ||
    payload.exp - payload.iat !== CONSENT_TOKEN_TTL_SECONDS ||
    !safeStringEqual(payload.subject, String(identity?.id || "")) ||
    !payload.request ||
    !isAllowedMcpResourceUrl(payload.request.resource, env) ||
    !Array.isArray(payload.request.scopes)
  ) {
    throw new McpOAuthError("Невалидно потвърждение.", 403, "access_denied");
  }
  return consentRequest({
    ...payload.request,
    scopes: parseScopes(payload.request.scopes.join(" ")),
  });
}

export function validateMcpConsentToken(
  token,
  request,
  identity,
  env = process.env,
  now = Math.floor(Date.now() / 1_000),
) {
  const trustedRequest = resolveMcpConsentRequest(token, identity, env, now);
  if (
    !safeStringEqual(
      JSON.stringify(trustedRequest),
      JSON.stringify(consentRequest(request)),
    )
  ) {
    throw new McpOAuthError("Невалидно потвърждение.", 403, "access_denied");
  }
  return true;
}

function wasTokenConsumed(store, tokenId, now) {
  for (const [storedId, expiresAt] of store) {
    if (expiresAt <= now) store.delete(storedId);
  }
  return store.has(tokenId);
}

function markTokenConsumed(store, tokenId, expiresAt) {
  store.set(tokenId, expiresAt);
  while (store.size > MAX_CONSUMED_TOKEN_RECORDS) {
    store.delete(store.keys().next().value);
  }
}

function replayStore(grantType) {
  return grantType === "authorization_code"
    ? consumedAuthorizationCodes
    : consumedRefreshTokens;
}

function replayRecordId(grantType, tokenId) {
  return createHash("sha256")
    .update(String(grantType))
    .update("\0")
    .update(String(tokenId))
    .digest("hex");
}

async function ensureMcpReplayIndex(client, env = process.env) {
  if (
    !client?.indices ||
    typeof client.indices.exists !== "function" ||
    typeof client.indices.create !== "function"
  ) {
    return;
  }
  if (!replayIndexPromise) {
    const index = env.MCP_OAUTH_REPLAY_INDEX || MCP_OAUTH_REPLAY_INDEX;
    replayIndexPromise = (async () => {
      const existsResponse = await client.indices.exists({ index });
      const exists = existsResponse.body ?? existsResponse;
      if (exists) return;
      try {
        await client.indices.create({
          index,
          body: {
            mappings: {
              properties: {
                grantType: { type: "keyword" },
                expiresAt: { type: "date" },
              },
            },
          },
        });
      } catch (error) {
        const status = openSearchStatus(error);
        const type = error?.meta?.body?.error?.type;
        if (status !== 400 || type !== "resource_already_exists_exception") {
          throw error;
        }
      }
    })().catch((error) => {
      replayIndexPromise = null;
      throw error;
    });
  }
  await replayIndexPromise;
}

function openSearchStatus(error) {
  return error?.statusCode || error?.meta?.statusCode || 0;
}

function mcpGrantIndex(env = process.env) {
  return env.MCP_OAUTH_GRANT_INDEX || MCP_OAUTH_GRANT_INDEX;
}

function mcpGrantUnavailable(message) {
  return new McpOAuthError(
    message || "MCP OAuth разрешенията временно не са достъпни.",
    503,
    "temporarily_unavailable",
  );
}

function inactiveMcpGrant(errorCode = "invalid_grant") {
  return new McpOAuthError(
    "MCP OAuth разрешението липсва или е отнето.",
    errorCode === "invalid_token" ? 401 : 400,
    errorCode,
  );
}

function normalizeGrantRecord(source, fallbackId = "") {
  if (!source || typeof source !== "object") return null;
  const scopes = Array.isArray(source.scopes)
    ? [...new Set(source.scopes.map(String))]
    : [];
  const issuedAtMs = Date.parse(String(source.issuedAt || ""));
  if (!Number.isFinite(issuedAtMs)) return null;
  const expiresAtMs = source.expiresAt
    ? Date.parse(String(source.expiresAt))
    : issuedAtMs + REFRESH_TOKEN_TTL_SECONDS * 1_000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) return null;
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const record = {
    grantId: String(source.grantId || fallbackId),
    subject: String(source.subject || ""),
    memoryOwnerId: String(source.memoryOwnerId || ""),
    role: String(source.role || ""),
    clientId: String(source.clientId || ""),
    scopes,
    issuedAt,
    expiresAt,
    lastUsedAt: source.lastUsedAt ? String(source.lastUsedAt) : null,
    revokedAt: source.revokedAt ? String(source.revokedAt) : null,
  };
  return record.grantId &&
    record.subject &&
    record.memoryOwnerId &&
    record.role &&
    record.clientId &&
    record.scopes.length > 0 &&
    record.issuedAt &&
    record.expiresAt
    ? record
    : null;
}

function mcpGrantRecord(
  payload,
  issuedAt = payload.iat,
  expiresAt = payload.exp,
) {
  return normalizeGrantRecord({
    grantId: payload.grantId,
    subject: payload.subject,
    memoryOwnerId: payload.memoryOwnerId,
    role: payload.role,
    clientId: payload.clientId,
    scopes: payload.scopes,
    issuedAt: new Date(Number(issuedAt) * 1_000).toISOString(),
    expiresAt: new Date(Number(expiresAt) * 1_000).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  });
}

function mcpGrantMatches(record, identity) {
  const subject = String(identity?.subject || identity?.id || "");
  const scopes = Array.isArray(identity?.scopes)
    ? [...new Set(identity.scopes.map(String))].sort()
    : null;
  return Boolean(
    record &&
    (!subject || record.subject === subject) &&
    (!identity?.memoryOwnerId ||
      record.memoryOwnerId === String(identity.memoryOwnerId)) &&
    (!identity?.role || record.role === String(identity.role)) &&
    (!identity?.clientId || record.clientId === String(identity.clientId)) &&
    (!scopes ||
      safeStringEqual(
        JSON.stringify([...record.scopes].sort()),
        JSON.stringify(scopes),
      )),
  );
}

function legacyGrantId(payload) {
  return `legacy_${createHash("sha256")
    .update(String(payload.iss))
    .update("\0")
    .update(String(payload.clientId))
    .update("\0")
    .update(String(payload.subject))
    .update("\0")
    .update(String(payload.jti))
    .digest("base64url")}`;
}

function withMcpGrantId(payload) {
  return payload.grantId
    ? payload
    : { ...payload, grantId: legacyGrantId(payload) };
}

async function ensureMcpGrantIndex(client, env = process.env) {
  if (
    !client?.indices ||
    typeof client.indices.exists !== "function" ||
    typeof client.indices.create !== "function"
  ) {
    return;
  }
  if (!grantIndexPromise) {
    const index = mcpGrantIndex(env);
    grantIndexPromise = (async () => {
      const existsResponse = await client.indices.exists({ index });
      const exists = existsResponse.body ?? existsResponse;
      if (exists) return;
      try {
        await client.indices.create({
          index,
          body: {
            mappings: {
              properties: {
                grantId: { type: "keyword" },
                subject: { type: "keyword" },
                memoryOwnerId: { type: "keyword" },
                role: { type: "keyword" },
                clientId: { type: "keyword" },
                scopes: { type: "keyword" },
                issuedAt: { type: "date" },
                expiresAt: { type: "date" },
                lastUsedAt: { type: "date" },
                revokedAt: { type: "date" },
              },
            },
          },
        });
      } catch (error) {
        const status = openSearchStatus(error);
        const type = error?.meta?.body?.error?.type;
        if (status !== 400 || type !== "resource_already_exists_exception") {
          throw error;
        }
      }
    })().catch((error) => {
      grantIndexPromise = null;
      throw error;
    });
  }
  await grantIndexPromise;
}

export function requiresPersistentMcpGrantStore(env = process.env) {
  return env.NODE_ENV === "production";
}

async function loadMcpGrant(
  grantId,
  {
    env = process.env,
    client = getOpenSearchClient(),
    firestoreStore = null,
  } = {},
) {
  const local = localMcpGrants.get(grantId) || null;
  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    try {
      const document = await getFirestoreMcpStore(env, firestoreStore).getGrant(
        grantId,
      );
      const source = document?.data || null;
      const record = normalizeGrantRecord(source, grantId);
      if (source && !record) {
        return { grantId, invalid: true, revokedAt: "invalid" };
      }
      if (record) localMcpGrants.set(grantId, record);
      return record;
    } catch {
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
    return local;
  }
  if (backend === "opensearch" && client && typeof client.get === "function") {
    try {
      const response = await client.get({
        index: mcpGrantIndex(env),
        id: grantId,
      });
      const source = response.body?._source ?? response._source;
      const record = normalizeGrantRecord(source, grantId);
      if (source && !record) {
        return { grantId, invalid: true, revokedAt: "invalid" };
      }
      if (record) localMcpGrants.set(grantId, record);
      return record;
    } catch (error) {
      if (openSearchStatus(error) === 404) {
        return requiresPersistentMcpGrantStore(env) ? null : local;
      }
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (requiresPersistentMcpGrantStore(env)) {
    throw mcpGrantUnavailable(
      "MCP OAuth хранилището за разрешения не е конфигурирано.",
    );
  }
  return local;
}

async function persistMcpGrant(
  payload,
  {
    env = process.env,
    client = getOpenSearchClient(),
    firestoreStore = null,
    issuedAt = payload.iat,
    expiresAt = payload.exp,
  } = {},
) {
  const record = mcpGrantRecord(payload, issuedAt, expiresAt);
  if (!record) throw inactiveMcpGrant();

  const local = localMcpGrants.get(record.grantId);
  if (local && !requiresPersistentMcpGrantStore(env)) {
    if (!mcpGrantMatches(local, record) || local.revokedAt) {
      throw inactiveMcpGrant();
    }
    return local;
  }
  if (local && requiresPersistentMcpGrantStore(env)) {
    const durable = await loadMcpGrant(record.grantId, {
      env,
      client,
      firestoreStore,
    });
    if (!mcpGrantMatches(durable, record) || durable?.revokedAt) {
      throw inactiveMcpGrant();
    }
    return durable;
  }

  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    try {
      await getFirestoreMcpStore(env, firestoreStore).createGrant(
        record.grantId,
        record,
      );
      localMcpGrants.set(record.grantId, record);
      return record;
    } catch (error) {
      if (isFirestoreAlreadyExists(error)) {
        const existing = await loadMcpGrant(record.grantId, {
          env,
          client,
          firestoreStore,
        });
        if (mcpGrantMatches(existing, record) && !existing.revokedAt) {
          return existing;
        }
        throw inactiveMcpGrant();
      }
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (
    backend === "opensearch" &&
    client &&
    typeof client.create === "function"
  ) {
    try {
      await ensureMcpGrantIndex(client, env);
      await client.create({
        index: mcpGrantIndex(env),
        id: record.grantId,
        body: record,
        refresh: true,
      });
      localMcpGrants.set(record.grantId, record);
      return record;
    } catch (error) {
      if (openSearchStatus(error) === 409) {
        const existing = await loadMcpGrant(record.grantId, {
          env,
          client,
          firestoreStore,
        });
        if (mcpGrantMatches(existing, record) && !existing.revokedAt) {
          return existing;
        }
        throw inactiveMcpGrant();
      }
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (requiresPersistentMcpGrantStore(env)) {
    throw mcpGrantUnavailable(
      "MCP OAuth хранилището за разрешения не е конфигурирано.",
    );
  }

  localMcpGrants.set(record.grantId, record);
  return record;
}

async function touchMcpGrant(
  record,
  {
    env = process.env,
    client = getOpenSearchClient(),
    firestoreStore = null,
    now = Date.now(),
    expiresAt = record.expiresAt,
  } = {},
) {
  const lastUsedAt = new Date(now).toISOString();
  const updated = {
    ...record,
    lastUsedAt,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    try {
      const result = await getFirestoreMcpStore(
        env,
        firestoreStore,
      ).mutateGrant(record.grantId, (source) => {
        const current = normalizeGrantRecord(source, record.grantId);
        if (!mcpGrantMatches(current, record) || current?.revokedAt) {
          throw inactiveMcpGrant();
        }
        return { ...current, lastUsedAt, expiresAt: updated.expiresAt };
      });
      if (!result) throw inactiveMcpGrant();
    } catch (error) {
      if (error instanceof McpOAuthError) throw error;
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (
    backend === "opensearch" &&
    client &&
    typeof client.update === "function"
  ) {
    try {
      await client.update({
        index: mcpGrantIndex(env),
        id: record.grantId,
        body: { doc: { lastUsedAt, expiresAt: updated.expiresAt } },
        refresh: false,
      });
    } catch (error) {
      if (openSearchStatus(error) === 404) throw inactiveMcpGrant();
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (requiresPersistentMcpGrantStore(env)) {
    throw mcpGrantUnavailable(
      "MCP OAuth хранилището за разрешения не е конфигурирано.",
    );
  }
  localMcpGrants.set(record.grantId, updated);
  return updated;
}

export async function assertMcpGrantActive(
  identity,
  {
    env = process.env,
    client = getOpenSearchClient(),
    firestoreStore = null,
    touch = false,
    now = Date.now(),
    expiresAt,
    errorCode = "invalid_token",
  } = {},
) {
  if (!identity?.grantId) {
    // Tokens minted before grant management expire within one hour. Let those
    // already-active access tokens finish naturally; every legacy refresh is
    // migrated to a durable grant before new tokens are issued.
    return {
      grantId: null,
      subject: String(identity?.subject || identity?.id || ""),
      memoryOwnerId: String(identity?.memoryOwnerId || ""),
      role: String(identity?.role || ""),
      clientId: String(identity?.clientId || ""),
      scopes: Array.isArray(identity?.scopes) ? [...identity.scopes] : [],
      issuedAt: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      legacy: true,
    };
  }

  let record = await loadMcpGrant(String(identity.grantId), {
    env,
    client,
    firestoreStore,
  });
  if (!record && !requiresPersistentMcpGrantStore(env)) {
    record = mcpGrantRecord(
      {
        ...identity,
        subject: identity.subject || identity.id,
        iat: Math.floor(now / 1_000),
        exp: Math.floor(now / 1_000) + REFRESH_TOKEN_TTL_SECONDS,
      },
      Math.floor(now / 1_000),
    );
    if (record) localMcpGrants.set(record.grantId, record);
  }
  if (
    !record ||
    record.revokedAt ||
    Date.parse(record.expiresAt) <= now ||
    !mcpGrantMatches(record, identity)
  ) {
    throw inactiveMcpGrant(errorCode);
  }
  return touch
    ? touchMcpGrant(record, {
        env,
        client,
        firestoreStore,
        now,
        expiresAt,
      })
    : record;
}

export async function listActiveMcpGrants({
  subject,
  env = process.env,
  client = getOpenSearchClient(),
  firestoreStore = null,
  limit = 100,
  now = Date.now(),
} = {}) {
  const cleanSubject = String(subject || "").trim();
  if (!cleanSubject) {
    throw new McpOAuthError("Липсва собственик на MCP OAuth разрешенията.");
  }
  const safeLimit = Math.min(
    Math.max(Number.parseInt(limit, 10) || 100, 1),
    100,
  );

  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    try {
      const documents = await getFirestoreMcpStore(
        env,
        firestoreStore,
      ).listGrantsBySubject(cleanSubject, 1_000);
      return documents
        .map((document) => normalizeGrantRecord(document.data, document.id))
        .filter(
          (record) =>
            record && !record.revokedAt && Date.parse(record.expiresAt) > now,
        )
        .sort((left, right) =>
          String(right.issuedAt).localeCompare(left.issuedAt),
        )
        .slice(0, safeLimit);
    } catch {
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (
    backend === "opensearch" &&
    client &&
    typeof client.search === "function"
  ) {
    try {
      const response = await client.search({
        index: mcpGrantIndex(env),
        body: {
          size: safeLimit,
          query: {
            bool: {
              filter: [
                { term: { subject: cleanSubject } },
                {
                  range: {
                    expiresAt: { gt: new Date(now).toISOString() },
                  },
                },
              ],
              must_not: [{ exists: { field: "revokedAt" } }],
            },
          },
          sort: [{ issuedAt: { order: "desc" } }],
        },
      });
      const hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
      return hits
        .map((hit) => normalizeGrantRecord(hit._source, hit._id))
        .filter(Boolean);
    } catch (error) {
      if (openSearchStatus(error) === 404) return [];
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
    }
  } else if (requiresPersistentMcpGrantStore(env)) {
    throw mcpGrantUnavailable(
      "MCP OAuth хранилището за разрешения не е конфигурирано.",
    );
  }

  return [...localMcpGrants.values()]
    .filter(
      (record) =>
        record.subject === cleanSubject &&
        !record.revokedAt &&
        Date.parse(record.expiresAt) > now,
    )
    .sort((left, right) => String(right.issuedAt).localeCompare(left.issuedAt))
    .slice(0, safeLimit);
}

function activeMcpGrantRevokeQuery(subject, grantId = "") {
  const filter = [{ term: { subject } }];
  if (grantId) filter.push({ term: { grantId } });
  return {
    bool: {
      filter,
      must_not: [{ exists: { field: "revokedAt" } }],
    },
  };
}

async function hasActiveMcpGrantForRevoke({ subject, grantId, env, client }) {
  if (!client || typeof client.search !== "function") {
    if (requiresPersistentMcpGrantStore(env)) {
      throw mcpGrantUnavailable(
        "MCP OAuth отнемането не може да бъде потвърдено.",
      );
    }
    return null;
  }
  try {
    const response = await client.search({
      index: mcpGrantIndex(env),
      body: {
        size: 1,
        _source: false,
        query: activeMcpGrantRevokeQuery(subject, grantId),
      },
    });
    const hits = response.body?.hits?.hits ?? response.hits?.hits ?? [];
    return hits.length > 0;
  } catch (error) {
    if (openSearchStatus(error) === 404) return false;
    if (requiresPersistentMcpGrantStore(env)) {
      throw mcpGrantUnavailable(
        "MCP OAuth отнемането не може да бъде потвърдено.",
      );
    }
    return null;
  }
}

export async function revokeMcpGrants({
  subject,
  grantId,
  env = process.env,
  client = getOpenSearchClient(),
  firestoreStore = null,
  now = Date.now(),
} = {}) {
  const cleanSubject = String(subject || "").trim();
  const cleanGrantId = String(grantId || "").trim();
  if (!cleanSubject) {
    throw new McpOAuthError("Липсва собственик на MCP OAuth разрешенията.");
  }
  const revokedAt = new Date(now).toISOString();
  let localRevoked = 0;
  for (const [id, record] of localMcpGrants) {
    if (
      record.subject === cleanSubject &&
      !record.revokedAt &&
      (!cleanGrantId || id === cleanGrantId)
    ) {
      localMcpGrants.set(id, { ...record, revokedAt });
      localRevoked += 1;
    }
  }

  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    try {
      return await getFirestoreMcpStore(env, firestoreStore).revokeGrants({
        subject: cleanSubject,
        grantId: cleanGrantId,
        revokedAt,
      });
    } catch {
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable(
          "MCP OAuth отнемането не можа да бъде потвърдено.",
        );
      }
      return localRevoked;
    }
  }
  if (
    backend === "opensearch" &&
    client &&
    typeof client.updateByQuery === "function"
  ) {
    try {
      let updated = 0;
      for (
        let attempt = 1;
        attempt <= MCP_GRANT_REVOKE_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const response = await client.updateByQuery({
          index: mcpGrantIndex(env),
          conflicts: "proceed",
          refresh: true,
          body: {
            query: activeMcpGrantRevokeQuery(cleanSubject, cleanGrantId),
            script: {
              source: "ctx._source.revokedAt = params.revokedAt",
              params: { revokedAt },
            },
          },
        });
        const body = response.body ?? response;
        updated += Number(body?.updated ?? 0);
        const versionConflicts = Number(body?.version_conflicts ?? 0);
        const stillActive = await hasActiveMcpGrantForRevoke({
          subject: cleanSubject,
          grantId: cleanGrantId,
          env,
          client,
        });
        if (stillActive === false) return updated;
        if (stillActive === null && versionConflicts === 0) return updated;
        if (attempt === MCP_GRANT_REVOKE_MAX_ATTEMPTS) {
          throw mcpGrantUnavailable(
            "MCP OAuth отнемането не можа да бъде потвърдено.",
          );
        }
      }
    } catch (error) {
      if (openSearchStatus(error) === 404) return 0;
      if (error instanceof McpOAuthError) throw error;
      if (requiresPersistentMcpGrantStore(env)) {
        throw mcpGrantUnavailable();
      }
      return localRevoked;
    }
  } else if (requiresPersistentMcpGrantStore(env)) {
    throw mcpGrantUnavailable(
      "MCP OAuth хранилището за разрешения не е конфигурирано.",
    );
  }
  return localRevoked;
}

export function requiresPersistentMcpReplayGuard(env = process.env) {
  return env.NODE_ENV === "production";
}

export async function cleanupExpiredMcpReplayRecords({
  client = getOpenSearchClient(),
  firestoreStore = null,
  env = process.env,
  now = Math.floor(Date.now() / 1_000),
  force = false,
} = {}) {
  const backend = resolvePersistenceBackend(env);
  if (
    backend !== "firestore" &&
    (!client || typeof client.deleteByQuery !== "function")
  ) {
    return false;
  }
  if (activeReplayCleanup) return activeReplayCleanup;
  if (
    !force &&
    lastReplayCleanupAt > 0 &&
    now - lastReplayCleanupAt < REPLAY_CLEANUP_INTERVAL_SECONDS
  ) {
    return false;
  }

  lastReplayCleanupAt = now;
  if (backend === "firestore") {
    activeReplayCleanup = getFirestoreMcpStore(env, firestoreStore)
      .cleanupExpiredReplay(now)
      .then(() => true)
      .catch(() => {
        console.error("[MCP OAuth replay] Expired-record cleanup failed.");
        return false;
      })
      .finally(() => {
        activeReplayCleanup = null;
      });
    return activeReplayCleanup;
  }

  activeReplayCleanup = client
    .deleteByQuery({
      index: env.MCP_OAUTH_REPLAY_INDEX || MCP_OAUTH_REPLAY_INDEX,
      conflicts: "proceed",
      refresh: false,
      body: {
        query: {
          range: {
            expiresAt: { lte: new Date(now * 1_000).toISOString() },
          },
        },
      },
    })
    .then(() => true)
    .catch((error) => {
      if (openSearchStatus(error) !== 404) {
        console.error("[MCP OAuth replay] Expired-record cleanup failed.");
      }
      return openSearchStatus(error) === 404;
    })
    .finally(() => {
      activeReplayCleanup = null;
    });

  return activeReplayCleanup;
}

export async function consumeMcpGrantOnce({
  grantType,
  tokenId,
  expiresAt,
  env = process.env,
  client = getOpenSearchClient(),
  firestoreStore = null,
}) {
  const store = replayStore(grantType);
  const now = Math.floor(Date.now() / 1_000);
  if (wasTokenConsumed(store, tokenId, now)) return false;

  const backend = resolvePersistenceBackend(env);
  if (backend === "firestore") {
    const firestoreReplayStore = getFirestoreMcpStore(env, firestoreStore);
    const replayId = replayRecordId(grantType, tokenId);
    const claimId = randomBytes(16).toString("base64url");
    let durableClaimCreated = false;
    try {
      await firestoreReplayStore.createReplay(replayId, {
        grantType,
        claimId,
        expiresAt: new Date(expiresAt * 1_000).toISOString(),
        expiresAtEpoch: Number(expiresAt),
      });
      durableClaimCreated = true;
    } catch (error) {
      if (isFirestoreAlreadyExists(error)) return false;
      try {
        const persisted = await firestoreReplayStore.getReplay(replayId);
        if (persisted?.data?.claimId === claimId) {
          durableClaimCreated = true;
        } else if (persisted) {
          return false;
        }
      } catch {
        // The durable result cannot be proven; production remains fail-closed.
      }
      if (!durableClaimCreated && requiresPersistentMcpReplayGuard(env)) {
        throw new McpOAuthError(
          "MCP OAuth еднократната защита временно не е достъпна.",
          503,
          "temporarily_unavailable",
        );
      }
    }
    if (durableClaimCreated) {
      await cleanupExpiredMcpReplayRecords({
        firestoreStore,
        env,
        now,
      });
    }
  } else if (backend === "opensearch" && client) {
    try {
      const replayIndex = env.MCP_OAUTH_REPLAY_INDEX || MCP_OAUTH_REPLAY_INDEX;
      await ensureMcpReplayIndex(client, env);
      await client.create({
        index: replayIndex,
        id: replayRecordId(grantType, tokenId),
        body: {
          grantType,
          expiresAt: new Date(expiresAt * 1_000).toISOString(),
        },
        refresh: true,
      });
      await cleanupExpiredMcpReplayRecords({ client, env, now });
    } catch (error) {
      if (openSearchStatus(error) === 409) return false;
      if (requiresPersistentMcpReplayGuard(env)) {
        throw new McpOAuthError(
          "MCP OAuth еднократната защита временно не е достъпна.",
          503,
          "temporarily_unavailable",
        );
      }
    }
  } else if (requiresPersistentMcpReplayGuard(env)) {
    throw new McpOAuthError(
      "MCP OAuth еднократната защита не е конфигурирана.",
      503,
      "temporarily_unavailable",
    );
  }

  markTokenConsumed(store, tokenId, expiresAt);
  return true;
}

function createAccessAndRefreshTokens(payload, env, now) {
  const accessToken = encryptPayload(
    "sx-token",
    {
      typ: "access_token",
      grantId: payload.grantId,
      iss: payload.iss,
      aud: payload.aud,
      clientId: payload.clientId,
      scopes: payload.scopes,
      subject: payload.subject,
      memoryOwnerId: payload.memoryOwnerId,
      role: payload.role,
      iat: now,
      nbf: now - 5,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    },
    oauthSecret(env),
  );
  const refreshToken = encryptPayload(
    "sx-refresh",
    {
      typ: "refresh_token",
      jti: randomBytes(18).toString("base64url"),
      grantId: payload.grantId,
      iss: payload.iss,
      aud: payload.aud,
      clientId: payload.clientId,
      scopes: payload.scopes,
      subject: payload.subject,
      memoryOwnerId: payload.memoryOwnerId,
      role: payload.role,
      iat: now,
      exp: now + REFRESH_TOKEN_TTL_SECONDS,
    },
    grantSecret(env),
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: payload.scopes.join(" "),
  };
}

export async function exchangeMcpAuthorizationCode(
  input,
  env = process.env,
  {
    consumeGrant = consumeMcpGrantOnce,
    client = getOpenSearchClient(),
    firestoreStore = null,
  } = {},
) {
  const code = String(input?.code || "");
  const payload = decryptPayloadWithFallback(
    code,
    "sx-code",
    grantVerificationSecrets(env),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "authorization_code" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    !isAllowedMcpResourceUrl(payload.aud, env) ||
    payload.exp <= now
  ) {
    throw new McpOAuthError(
      "Невалиден или изтекъл authorization code.",
      400,
      "invalid_grant",
    );
  }
  if (
    input?.grant_type !== "authorization_code" ||
    !safeStringEqual(input?.client_id, payload.clientId) ||
    !safeStringEqual(input?.redirect_uri, payload.redirectUri) ||
    !safeStringEqual(input?.resource, payload.aud)
  ) {
    throw new McpOAuthError(
      "Authorization code не съвпада със заявката.",
      400,
      "invalid_grant",
    );
  }
  const verifier = String(input?.code_verifier || "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
    throw new McpOAuthError("Невалиден PKCE verifier.", 400, "invalid_grant");
  }
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (!safeStringEqual(challenge, payload.codeChallenge)) {
    throw new McpOAuthError(
      "PKCE проверката е неуспешна.",
      400,
      "invalid_grant",
    );
  }

  const grantPayload = withMcpGrantId(payload);
  await persistMcpGrant(grantPayload, {
    env,
    client,
    firestoreStore,
    issuedAt: payload.iat,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
  });
  const consumed = await consumeGrant({
    grantType: "authorization_code",
    tokenId: payload.jti,
    expiresAt: payload.exp,
    env,
    client,
    firestoreStore,
  });
  if (!consumed) {
    throw new McpOAuthError(
      "Невалиден или изтекъл authorization code.",
      400,
      "invalid_grant",
    );
  }
  return createAccessAndRefreshTokens(grantPayload, env, now);
}

export async function exchangeMcpRefreshToken(
  input,
  env = process.env,
  {
    consumeGrant = consumeMcpGrantOnce,
    client = getOpenSearchClient(),
    firestoreStore = null,
  } = {},
) {
  const payload = decryptPayloadWithFallback(
    String(input?.refresh_token || ""),
    "sx-refresh",
    grantVerificationSecrets(env),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "refresh_token" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    !isAllowedMcpResourceUrl(payload.aud, env) ||
    payload.exp <= now ||
    !safeStringEqual(input?.client_id, payload.clientId) ||
    !safeStringEqual(input?.resource, payload.aud)
  ) {
    throw new McpOAuthError(
      "Невалиден или изтекъл refresh token.",
      400,
      "invalid_grant",
    );
  }
  const grantPayload = withMcpGrantId(payload);
  if (payload.grantId) {
    await assertMcpGrantActive(payload, {
      env,
      client,
      firestoreStore,
      touch: true,
      now: now * 1_000,
      expiresAt: (now + REFRESH_TOKEN_TTL_SECONDS) * 1_000,
      errorCode: "invalid_grant",
    });
  } else {
    // Pre-grant refresh tokens get one replay-protected migration to a durable
    // grant. The deterministic ID makes a retry idempotent.
    await persistMcpGrant(grantPayload, {
      env,
      client,
      firestoreStore,
      issuedAt: payload.iat,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
    });
  }
  const consumed = await consumeGrant({
    grantType: "refresh_token",
    tokenId: payload.jti,
    expiresAt: payload.exp,
    env,
    client,
    firestoreStore,
  });
  if (!consumed) {
    throw new McpOAuthError(
      "Невалиден или изтекъл refresh token.",
      400,
      "invalid_grant",
    );
  }
  return createAccessAndRefreshTokens(grantPayload, env, now);
}

export async function exchangeMcpToken(input, env = process.env) {
  const grantType = String(input?.grant_type || "unknown");
  try {
    let result;
    if (grantType === "authorization_code") {
      result = await exchangeMcpAuthorizationCode(input, env);
    } else if (grantType === "refresh_token") {
      result = await exchangeMcpRefreshToken(input, env);
    } else {
      throw new McpOAuthError(
        "Неподдържан OAuth grant.",
        400,
        "unsupported_grant_type",
      );
    }
    oauthRuntimeStatus = Object.freeze({
      ...oauthRuntimeStatus,
      tokenExchange: "success",
      grantType,
      errorCode: null,
      updatedAt: new Date().toISOString(),
    });
    recordOpenAiTunnelTokenExchange(
      input,
      { tokenExchange: "success", grantType },
      env,
    );
    return result;
  } catch (error) {
    oauthRuntimeStatus = Object.freeze({
      ...oauthRuntimeStatus,
      tokenExchange: "failed",
      grantType,
      errorCode: error instanceof McpOAuthError ? error.code : "server_error",
      updatedAt: new Date().toISOString(),
    });
    recordOpenAiTunnelTokenExchange(
      input,
      {
        tokenExchange: "failed",
        grantType,
        errorCode: error instanceof McpOAuthError ? error.code : "server_error",
      },
      env,
    );
    throw error;
  }
}

export function recordMcpAuthorizationRuntimeStatus({
  authorization,
  decision = null,
  errorCode = null,
}) {
  oauthRuntimeStatus = Object.freeze({
    ...oauthRuntimeStatus,
    authorization,
    authorizationDecision: decision,
    authorizationErrorCode: errorCode,
    authorizationUpdatedAt: new Date().toISOString(),
  });
}

export function getMcpOAuthRuntimeStatus() {
  return { ...oauthRuntimeStatus };
}

export function getMcpOpenAiTunnelRuntimeStatus(env = process.env) {
  const configured = Boolean(resolveOpenAiTunnelResourceUrl(env));
  return {
    configured,
    tokenExchange: configured
      ? openAiTunnelRuntimeStatus.tokenExchange
      : "not-configured",
    endToEndVerified:
      configured && openAiTunnelRuntimeStatus.tokenExchange === "success",
    grantType: configured ? openAiTunnelRuntimeStatus.grantType : null,
    errorCode: configured ? openAiTunnelRuntimeStatus.errorCode : null,
    updatedAt: configured ? openAiTunnelRuntimeStatus.updatedAt : null,
  };
}

export function verifyMcpAccessToken(
  authorizationHeader,
  requiredScopes = [MCP_READ_SCOPE],
  env = process.env,
) {
  if (
    typeof authorizationHeader !== "string" ||
    !authorizationHeader.startsWith("Bearer ")
  ) {
    return null;
  }
  const payload = decryptPayloadWithFallback(
    authorizationHeader.slice(7),
    "sx-token",
    oauthVerificationSecrets(env),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "access_token" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    !isAllowedMcpResourceUrl(payload.aud, env) ||
    payload.nbf > now ||
    payload.exp <= now ||
    !Array.isArray(payload.scopes) ||
    !payload.subject ||
    !payload.memoryOwnerId ||
    !["owner", "member", "tester"].includes(payload.role)
  ) {
    throw new McpOAuthError(
      "Невалиден или изтекъл MCP token.",
      401,
      "invalid_token",
    );
  }
  if (
    requiredScopes.some((scope) => !payload.scopes.includes(scope)) ||
    (requiresOwnerRole(requiredScopes) && payload.role !== "owner")
  ) {
    throw new McpOAuthError(
      "MCP token няма необходимите права.",
      403,
      "insufficient_scope",
    );
  }
  return {
    id: payload.subject,
    memoryOwnerId: payload.memoryOwnerId,
    role: payload.role,
    scopes: payload.scopes,
    clientId: payload.clientId,
    grantId: payload.grantId || null,
  };
}

export function resetMcpOAuthStateForTests() {
  consumedAuthorizationCodes.clear();
  consumedRefreshTokens.clear();
  localMcpGrants.clear();
  replayIndexPromise = null;
  grantIndexPromise = null;
  setFirestoreMcpOAuthStoreForTests(null);
  lastReplayCleanupAt = 0;
  activeReplayCleanup = null;
  oauthRuntimeStatus = Object.freeze({
    authorization: "not-attempted",
    authorizationDecision: null,
    authorizationErrorCode: null,
    authorizationUpdatedAt: null,
    tokenExchange: "not-attempted",
    grantType: null,
    errorCode: null,
    updatedAt: null,
  });
  openAiTunnelRuntimeStatus = Object.freeze({
    tokenExchange: "not-attempted",
    grantType: null,
    errorCode: null,
    updatedAt: null,
  });
}
