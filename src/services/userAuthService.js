import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { resolveTesterAuthConnection } from "../config/testerAuthBootstrap.js";
import {
  approveTesterAccess,
  assertTesterAccess,
  TesterAccessError,
} from "./testerAccessService.js";

export const USER_SESSION_COOKIE = "synchron_user_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_KEY_SALT = "synchron-supabase-session-v1";
let cachedEncryptionSecret = "";
let cachedEncryptionKey = null;

export class UserAuthError extends Error {
  constructor(message, status = 401, code = "AUTH_ERROR") {
    super(message);
    this.name = "UserAuthError";
    this.status = status;
    this.code = code;
  }
}

function sessionSecret(env = process.env) {
  return (env.SUPABASE_SESSION_ENCRYPTION_KEY || "").trim();
}

export function getTesterInviteCode(env = process.env) {
  return (env.SYNCHRON_TEST_INVITE_CODE || "").trim();
}

function authConfig(env = process.env) {
  const { projectUrl, publishableKey } = resolveTesterAuthConnection(env);
  return {
    projectUrl,
    publishableKey,
    encryptionSecret: sessionSecret(env),
  };
}

export function getUserAuthConfigurationStatus(env = process.env) {
  const config = authConfig(env);
  return {
    projectConnection: Boolean(config.projectUrl && config.publishableKey),
    sessionProtection: config.encryptionSecret.length >= 16,
  };
}

export function isUserAuthConfigured(env = process.env) {
  const status = getUserAuthConfigurationStatus(env);
  return status.projectConnection && status.sessionProtection;
}

export function isTesterRegistrationEnabled(env = process.env) {
  return getTesterInviteCode(env).length >= 8;
}

export function isUserRegistrationEnabled(env = process.env) {
  return isUserAuthConfigured(env);
}

function requireAuthConfig(env = process.env) {
  const config = authConfig(env);
  if (!config.projectUrl || !config.publishableKey) {
    throw new UserAuthError(
      "Входът с потребителски профил още не е конфигуриран.",
      503,
      "AUTH_NOT_CONFIGURED",
    );
  }
  if (config.encryptionSecret.length < 16) {
    throw new UserAuthError(
      "Защитата на потребителските сесии още не е конфигурирана.",
      503,
      "AUTH_SESSION_KEY_MISSING",
    );
  }
  return config;
}

function supabaseAuthError(status, payload) {
  const error = new Error(
    payload?.msg ||
      payload?.message ||
      payload?.error_description ||
      payload?.error ||
      "Supabase Auth request failed.",
  );
  error.status = status;
  return error;
}

async function supabaseAuthRequest(
  config,
  path,
  { method = "GET", accessToken = "", body } = {},
) {
  const response = await fetch(`${config.projectUrl}/auth/v1${path}`, {
    method,
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${accessToken || config.publishableKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw supabaseAuthError(response.status, payload);
  return payload;
}

function normalizeRemoteSession(payload) {
  if (!payload?.access_token || !payload?.refresh_token) return null;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at:
      Number(payload.expires_at) ||
      Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
    token_type: payload.token_type || "bearer",
  };
}

function createAuthClient(env = process.env) {
  const config = requireAuthConfig(env);
  return {
    auth: {
      async signInWithPassword(credentials) {
        try {
          const payload = await supabaseAuthRequest(
            config,
            "/token?grant_type=password",
            { method: "POST", body: credentials },
          );
          return {
            data: {
              user: payload.user,
              session: normalizeRemoteSession(payload),
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async signUp({ email, password, options = {} }) {
        try {
          const payload = await supabaseAuthRequest(config, "/signup", {
            method: "POST",
            body: { email, password, data: options.data || {} },
          });
          return {
            data: {
              user: payload.user,
              session: normalizeRemoteSession(payload),
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async getUser(accessToken) {
        try {
          const user = await supabaseAuthRequest(config, "/user", {
            accessToken,
          });
          return { data: { user }, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      async refreshSession({ refresh_token }) {
        try {
          const payload = await supabaseAuthRequest(
            config,
            "/token?grant_type=refresh_token",
            { method: "POST", body: { refresh_token } },
          );
          return {
            data: {
              user: payload.user,
              session: normalizeRemoteSession(payload),
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async signOut(accessToken) {
        try {
          await supabaseAuthRequest(config, "/logout?scope=local", {
            method: "POST",
            accessToken,
          });
        } catch {
          // The application cookie is still cleared locally.
        }
      },
    },
  };
}

function deriveSessionKey(env = process.env) {
  const { encryptionSecret } = requireAuthConfig(env);
  if (cachedEncryptionKey && cachedEncryptionSecret === encryptionSecret) {
    return cachedEncryptionKey;
  }
  cachedEncryptionSecret = encryptionSecret;
  cachedEncryptionKey = scryptSync(encryptionSecret, SESSION_KEY_SALT, 32);
  return cachedEncryptionKey;
}

function sessionPayload(session) {
  if (
    typeof session?.access_token !== "string" ||
    typeof session?.refresh_token !== "string"
  ) {
    throw new UserAuthError(
      "Supabase не върна валидна потребителска сесия.",
      502,
      "AUTH_INVALID_SESSION",
    );
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Number(session.expires_at) || 0,
    token_type: session.token_type || "bearer",
  };
}

export function encryptUserSession(session, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveSessionKey(env), iv);
  const plaintext = Buffer.from(
    JSON.stringify(sessionPayload(session)),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptUserSession(value, env = process.env) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length < 29) return null;
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveSessionKey(env), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return sessionPayload(JSON.parse(plaintext));
  } catch {
    return null;
  }
}

export function parseCookies(header = "") {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return cookies;
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      cookies[key] = value;
      return cookies;
    }, {});
}

export function userSessionCookie(session, env = process.env) {
  return [
    `${USER_SESSION_COOKIE}=${encryptUserSession(session, env)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

export function clearUserSessionCookie() {
  return `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cleanEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) {
    throw new UserAuthError(
      "Въведи валиден имейл адрес.",
      400,
      "AUTH_INVALID_EMAIL",
    );
  }
  return email;
}

function cleanPassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8 || password.length > 128) {
    throw new UserAuthError(
      "Паролата трябва да е между 8 и 128 знака.",
      400,
      "AUTH_INVALID_PASSWORD",
    );
  }
  return password;
}

function cleanDisplayName(value, email) {
  const displayName =
    typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  if (displayName.length > 80) {
    throw new UserAuthError(
      "Името трябва да е до 80 знака.",
      400,
      "AUTH_INVALID_NAME",
    );
  }
  return displayName || email.split("@")[0];
}

function mapAuthError(error, fallbackMessage) {
  const status = Number(error?.status);
  if (status === 400 || status === 401) {
    return new UserAuthError(fallbackMessage, 401, "AUTH_INVALID_CREDENTIALS");
  }
  if (status === 422) {
    return new UserAuthError(
      error?.message || "Потребителският профил не можа да бъде създаден.",
      422,
      "AUTH_SIGNUP_REJECTED",
    );
  }
  return new UserAuthError(
    "Услугата за вход временно не е достъпна.",
    503,
    "AUTH_UNAVAILABLE",
  );
}

function mapTesterAccessError(error) {
  if (
    error instanceof TesterAccessError ||
    (typeof error?.code === "string" && error.code.startsWith("TESTER_ACCESS_"))
  ) {
    return new UserAuthError(
      error.message || "Тестовият достъп беше отказан.",
      Number(error.status) || 503,
      error.code,
    );
  }
  return new UserAuthError(
    "Проверката на тестовия достъп временно не е достъпна.",
    503,
    "TESTER_ACCESS_UNAVAILABLE",
  );
}

export async function signInUser(
  { email, password },
  { env = process.env, client, requireTesterAccess = assertTesterAccess } = {},
) {
  const authClient = client || createAuthClient(env);
  const credentials = {
    email: cleanEmail(email),
    password: cleanPassword(password),
  };
  const { data, error } = await authClient.auth.signInWithPassword(credentials);
  if (error || !data?.user || !data?.session) {
    throw mapAuthError(error, "Имейлът или паролата са неправилни.");
  }
  try {
    await requireTesterAccess(data.user, { env });
  } catch (error) {
    throw mapTesterAccessError(error);
  }
  return { user: data.user, session: sessionPayload(data.session) };
}

export async function registerUser(
  { email, password, displayName },
  { env = process.env, client, approveAccess = approveTesterAccess } = {},
) {
  const cleanCredentials = {
    email: cleanEmail(email),
    password: cleanPassword(password),
  };
  const authClient = client || createAuthClient(env);

  let { data, error } = await authClient.auth.signUp({
    ...cleanCredentials,
    options: {
      data: {
        display_name: cleanDisplayName(displayName, cleanCredentials.email),
      },
    },
  });

  if (error || !data?.user || !data?.session) {
    const recovered =
      await authClient.auth.signInWithPassword(cleanCredentials);
    if (!recovered.error && recovered.data?.user && recovered.data?.session) {
      data = recovered.data;
      error = null;
    }
  }

  const isObfuscatedExistingUser =
    !data?.session &&
    Array.isArray(data?.user?.identities) &&
    data.user.identities.length === 0;
  if (isObfuscatedExistingUser) {
    throw new UserAuthError(
      "Профилът не можа да бъде създаден. Ако вече имаш профил, върни се към входа.",
      422,
      "AUTH_SIGNUP_REJECTED",
    );
  }

  if (error || !data?.user) {
    throw mapAuthError(
      error,
      "Потребителският профил не можа да бъде създаден.",
    );
  }
  try {
    await approveAccess(data.user, { env });
  } catch (error) {
    throw mapTesterAccessError(error);
  }
  return {
    user: data.user,
    session: data.session ? sessionPayload(data.session) : null,
    confirmationRequired: !data.session,
  };
}

function publicUser(user, env = process.env) {
  const primaryUserId =
    typeof env.SYNCHRON_PRIMARY_SUPABASE_USER_ID === "string"
      ? env.SYNCHRON_PRIMARY_SUPABASE_USER_ID.trim()
      : "";
  const isPrimary = Boolean(primaryUserId && user.id === primaryUserId);
  const email = typeof user.email === "string" ? user.email : "";
  const metadataName =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name.trim()
      : "";

  return {
    id: user.id,
    email,
    displayName: metadataName || email.split("@")[0] || "Потребител",
    role: isPrimary ? "owner" : "member",
    memoryOwnerId: isPrimary
      ? env.MEMORY_OWNER_ID || "primary-user"
      : `supabase:${user.id}`,
  };
}

export async function resolveUserSession(
  cookieHeader,
  { env = process.env, client, requireTesterAccess = assertTesterAccess } = {},
) {
  const encrypted = parseCookies(cookieHeader)[USER_SESSION_COOKIE];
  const storedSession = decryptUserSession(encrypted, env);
  if (!storedSession) return null;
  const authClient = client || createAuthClient(env);

  let currentSession = storedSession;
  let refreshed = false;
  let user = null;
  const expiresSoon =
    !storedSession.expires_at ||
    storedSession.expires_at * 1000 <= Date.now() + 60_000;

  if (!expiresSoon) {
    const result = await authClient.auth.getUser(storedSession.access_token);
    if (!result.error && result.data?.user) user = result.data.user;
  }

  if (!user) {
    const result = await authClient.auth.refreshSession({
      refresh_token: storedSession.refresh_token,
    });
    if (result.error || !result.data?.session || !result.data?.user)
      return null;
    currentSession = sessionPayload(result.data.session);
    user = result.data.user;
    refreshed = true;
  }

  try {
    await requireTesterAccess(user, { env });
  } catch (error) {
    if (error?.code === "TESTER_ACCESS_NOT_APPROVED") return null;
    throw error;
  }

  return {
    user: publicUser(user, env),
    session: currentSession,
    refreshed,
  };
}

export async function signOutUser(
  cookieHeader,
  { env = process.env, client } = {},
) {
  const encrypted = parseCookies(cookieHeader)[USER_SESSION_COOKIE];
  const storedSession = decryptUserSession(encrypted, env);
  if (!storedSession) return;
  const authClient = client || createAuthClient(env);
  try {
    await authClient.auth.signOut(storedSession.access_token);
  } catch {
    // The local cookie is cleared even when the upstream session has expired.
  }
}
