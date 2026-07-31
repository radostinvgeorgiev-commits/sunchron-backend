import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

export const DEFAULT_MCP_RESOURCE_URL = "https://synchron.foundation/mcp";
export const MCP_READ_SCOPE = "synchron:read";
export const MCP_GITHUB_WRITE_SCOPE = "synchron:github.write";
export const MCP_SCOPES = Object.freeze([
  MCP_READ_SCOPE,
  MCP_GITHUB_WRITE_SCOPE,
]);

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const MAX_CONSUMED_TOKEN_RECORDS = 10_000;
const REPLAY_CLEANUP_INTERVAL_SECONDS = 6 * 60 * 60;
const MCP_OAUTH_REPLAY_INDEX =
  process.env.MCP_OAUTH_REPLAY_INDEX || "synchron-mcp-oauth-replay-v1";
const consumedAuthorizationCodes = new Map();
const consumedRefreshTokens = new Map();
let lastReplayCleanupAt = 0;
let activeReplayCleanup = null;

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

export function resolveMcpIssuerUrl(env = process.env) {
  return new URL(resolveMcpResourceUrl(env)).origin;
}

function normalizedSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deriveSecret(label, source) {
  return createHash("sha256").update(label).update(source).digest();
}

function legacyOAuthSecret(env = process.env, { required = true } = {}) {
  const source = normalizedSecret(env.MCP_ACCESS_TOKEN);
  if (source.length < 32) {
    if (!required) return null;
    throw new McpOAuthError(
      "MCP OAuth защитата не е конфигурирана.",
      503,
      "temporarily_unavailable",
    );
  }
  return deriveSecret("synchron-mcp-oauth-v1\0", source);
}

function dedicatedOAuthSecret(env = process.env) {
  const source = normalizedSecret(env.MCP_OAUTH_SECRET);
  if (!source) return null;
  if (source.length < 32) {
    throw new McpOAuthError(
      "Отделната MCP OAuth тайна трябва да бъде поне 32 знака.",
      503,
      "temporarily_unavailable",
    );
  }
  return deriveSecret("synchron-mcp-oauth-dedicated-v1\0", source);
}

function oauthSecrets(env = process.env) {
  const dedicated = dedicatedOAuthSecret(env);
  const legacy = legacyOAuthSecret(env, { required: !dedicated });
  return dedicated && legacy ? [dedicated, legacy] : [dedicated || legacy];
}

function grantSecretFromOAuthSecret(secretValue) {
  return createHash("sha256")
    .update(secretValue)
    .update("synchron-mcp-oauth-grants-v2\0")
    .digest();
}

function primaryOAuthSecret(env = process.env) {
  return oauthSecrets(env)[0];
}

function grantSecrets(env = process.env) {
  return oauthSecrets(env).map(grantSecretFromOAuthSecret);
}

function primaryGrantSecret(env = process.env) {
  return grantSecrets(env)[0];
}

export function getMcpOAuthSecretMode(env = process.env) {
  dedicatedOAuthSecret(env);
  return normalizedSecret(env.MCP_OAUTH_SECRET)
    ? "dedicated"
    : "legacy_fallback";
}

export function isMcpOAuthConfigured(env = process.env) {
  try {
    return Boolean(resolveMcpResourceUrl(env) && primaryOAuthSecret(env));
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
    scopes_supported: MCP_SCOPES,
  };
}

export function requiredScopesForMcpTool(name) {
  return name === "prepare_github_merged_branch_cleanup" ||
    name === "confirm_github_merged_branch_cleanup"
    ? [MCP_GITHUB_WRITE_SCOPE]
    : [MCP_READ_SCOPE];
}

export function mcpToolSecuritySchemes(name) {
  return Object.freeze([
    Object.freeze({
      type: "oauth2",
      scopes: Object.freeze(requiredScopesForMcpTool(name)),
    }),
  ]);
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

function decryptPayloadWithSecrets(value, prefix, secrets) {
  for (const secretValue of secrets) {
    const payload = decryptPayload(value, prefix, secretValue);
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
    scopes.some((scope) => !MCP_SCOPES.includes(scope))
  ) {
    throw new McpOAuthError(
      "Поисканите MCP права не се поддържат.",
      400,
      "invalid_scope",
    );
  }
  return scopes;
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

export async function validateMcpAuthorizationRequest(
  input,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const resource = resolveMcpResourceUrl(env);
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
  if (String(input?.resource || "") !== resource) {
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
    throw new McpOAuthError(
      "OAuth клиентът не може да бъде проверен.",
      400,
      "invalid_client",
    );
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
    throw new McpOAuthError("Липсва валиден SYNCHRON-X профил.", 401);
  }
  if (
    request.scopes.includes(MCP_GITHUB_WRITE_SCOPE) &&
    identity.role !== "owner"
  ) {
    throw new McpOAuthError(
      "GitHub записът е достъпен само за собственика.",
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
    primaryGrantSecret(env),
  );
}

function safeStringEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
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

function openSearchStatus(error) {
  return error?.statusCode || error?.meta?.statusCode || 0;
}

export function requiresPersistentMcpReplayGuard(env = process.env) {
  return env.NODE_ENV === "production";
}

export async function cleanupExpiredMcpReplayRecords({
  client = getOpenSearchClient(),
  env = process.env,
  now = Math.floor(Date.now() / 1_000),
  force = false,
} = {}) {
  if (!client || typeof client.deleteByQuery !== "function") return false;
  if (activeReplayCleanup) return activeReplayCleanup;
  if (
    !force &&
    lastReplayCleanupAt > 0 &&
    now - lastReplayCleanupAt < REPLAY_CLEANUP_INTERVAL_SECONDS
  ) {
    return false;
  }

  lastReplayCleanupAt = now;
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
}) {
  const store = replayStore(grantType);
  const now = Math.floor(Date.now() / 1_000);
  if (wasTokenConsumed(store, tokenId, now)) return false;

  if (client) {
    try {
      const replayIndex = env.MCP_OAUTH_REPLAY_INDEX || MCP_OAUTH_REPLAY_INDEX;
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
    primaryOAuthSecret(env),
  );
  const refreshToken = encryptPayload(
    "sx-refresh",
    {
      typ: "refresh_token",
      jti: randomBytes(18).toString("base64url"),
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
    primaryGrantSecret(env),
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
  { consumeGrant = consumeMcpGrantOnce } = {},
) {
  const code = String(input?.code || "");
  const payload = decryptPayloadWithSecrets(code, "sx-code", grantSecrets(env));
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "authorization_code" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    payload.aud !== resolveMcpResourceUrl(env) ||
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

  const consumed = await consumeGrant({
    grantType: "authorization_code",
    tokenId: payload.jti,
    expiresAt: payload.exp,
    env,
  });
  if (!consumed) {
    throw new McpOAuthError(
      "Невалиден или изтекъл authorization code.",
      400,
      "invalid_grant",
    );
  }
  return createAccessAndRefreshTokens(payload, env, now);
}

export async function exchangeMcpRefreshToken(
  input,
  env = process.env,
  { consumeGrant = consumeMcpGrantOnce } = {},
) {
  const payload = decryptPayloadWithSecrets(
    String(input?.refresh_token || ""),
    "sx-refresh",
    grantSecrets(env),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "refresh_token" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    payload.aud !== resolveMcpResourceUrl(env) ||
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
  const consumed = await consumeGrant({
    grantType: "refresh_token",
    tokenId: payload.jti,
    expiresAt: payload.exp,
    env,
  });
  if (!consumed) {
    throw new McpOAuthError(
      "Невалиден или изтекъл refresh token.",
      400,
      "invalid_grant",
    );
  }
  return createAccessAndRefreshTokens(payload, env, now);
}

export async function exchangeMcpToken(input, env = process.env) {
  if (input?.grant_type === "authorization_code") {
    return exchangeMcpAuthorizationCode(input, env);
  }
  if (input?.grant_type === "refresh_token") {
    return exchangeMcpRefreshToken(input, env);
  }
  throw new McpOAuthError(
    "Неподдържан OAuth grant.",
    400,
    "unsupported_grant_type",
  );
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
  const payload = decryptPayloadWithSecrets(
    authorizationHeader.slice(7),
    "sx-token",
    oauthSecrets(env),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !payload ||
    payload.typ !== "access_token" ||
    payload.iss !== resolveMcpIssuerUrl(env) ||
    payload.aud !== resolveMcpResourceUrl(env) ||
    payload.nbf > now ||
    payload.exp <= now ||
    !Array.isArray(payload.scopes) ||
    !payload.subject ||
    !payload.memoryOwnerId ||
    !["owner", "tester"].includes(payload.role)
  ) {
    throw new McpOAuthError(
      "Невалиден или изтекъл MCP token.",
      401,
      "invalid_token",
    );
  }
  if (
    requiredScopes.some((scope) => !payload.scopes.includes(scope)) ||
    (requiredScopes.includes(MCP_GITHUB_WRITE_SCOPE) &&
      payload.role !== "owner")
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
  };
}

export function resetMcpOAuthStateForTests() {
  consumedAuthorizationCodes.clear();
  consumedRefreshTokens.clear();
  lastReplayCleanupAt = 0;
  activeReplayCleanup = null;
}
