import {
  isIdentityPlatformConfigured,
  resolveIdentityPlatformApiKey,
  resolveIdentityPlatformProjectId,
} from "../config/authBackend.js";

const IDENTITY_TOOLKIT_ORIGIN = "https://identitytoolkit.googleapis.com";
const SECURE_TOKEN_ORIGIN = "https://securetoken.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;

function configurationError() {
  const error = new Error("Identity Platform не е конфигуриран.");
  error.status = 503;
  error.code = "IDENTITY_PLATFORM_NOT_CONFIGURED";
  return error;
}

function upstreamError(status, payload) {
  const error = new Error("Identity Platform request failed.");
  error.status = Number(status) || 503;
  error.code = "IDENTITY_PLATFORM_REQUEST_FAILED";
  error.upstreamCode = String(payload?.error?.message || "")
    .split(" : ")[0]
    .trim();
  return error;
}

function timeoutMs(env) {
  const parsed = Number.parseInt(env.IDENTITY_PLATFORM_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function requiresEmailVerification(env) {
  return env.IDENTITY_PLATFORM_REQUIRE_EMAIL_VERIFICATION !== "false";
}

function normalizeUser(payload = {}) {
  const id = String(payload.localId || "").trim();
  if (!id) return null;
  return {
    id,
    email: String(payload.email || "")
      .trim()
      .toLowerCase(),
    displayName: String(payload.displayName || "").trim(),
    emailVerified: payload.emailVerified === true,
    authProvider: "identity-platform",
  };
}

function normalizeSession(payload = {}) {
  const accessToken = payload.idToken || payload.id_token;
  const refreshToken = payload.refreshToken || payload.refresh_token;
  if (!accessToken || !refreshToken) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at:
      Math.floor(Date.now() / 1000) +
      Math.max(1, Number(payload.expiresIn || payload.expires_in || 3600)),
    token_type: payload.tokenType || payload.token_type || "Bearer",
  };
}

export function createIdentityPlatformAuthClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!isIdentityPlatformConfigured(env) || typeof fetchImpl !== "function") {
    throw configurationError();
  }
  const projectId = resolveIdentityPlatformProjectId(env);
  const apiKey = resolveIdentityPlatformApiKey(env);
  const requestTimeoutMs = timeoutMs(env);

  async function request(origin, path, { body, form = false } = {}) {
    const url = new URL(`/v1/${path}`, origin);
    url.searchParams.set("key", apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": form
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        body: form ? new URLSearchParams(body) : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const error = new Error("Identity Platform временно не отговаря.");
      error.status = 503;
      error.code = "IDENTITY_PLATFORM_UNAVAILABLE";
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw upstreamError(response.status, payload);
    return payload;
  }

  async function lookupUser(idToken) {
    const payload = await request(IDENTITY_TOOLKIT_ORIGIN, "accounts:lookup", {
      body: { idToken },
    });
    const user = normalizeUser(payload?.users?.[0]);
    if (!user)
      throw upstreamError(502, { error: { message: "USER_NOT_FOUND" } });
    return user;
  }

  async function sendVerificationEmail(idToken) {
    await request(IDENTITY_TOOLKIT_ORIGIN, "accounts:sendOobCode", {
      body: { requestType: "VERIFY_EMAIL", idToken },
    });
  }

  return Object.freeze({
    provider: "identity-platform",
    projectId,
    auth: Object.freeze({
      async signInWithPassword({ email, password }) {
        try {
          const payload = await request(
            IDENTITY_TOOLKIT_ORIGIN,
            "accounts:signInWithPassword",
            { body: { email, password, returnSecureToken: true } },
          );
          const session = normalizeSession(payload);
          const user = session
            ? await lookupUser(session.access_token)
            : normalizeUser(payload);
          return {
            data: {
              user,
              session,
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async signUp({ email, password, options = {} }) {
        try {
          let payload = await request(
            IDENTITY_TOOLKIT_ORIGIN,
            "accounts:signUp",
            { body: { email, password, returnSecureToken: true } },
          );
          const displayName = String(options.data?.display_name || "").trim();
          if (displayName && payload.idToken) {
            try {
              payload = await request(
                IDENTITY_TOOLKIT_ORIGIN,
                "accounts:update",
                {
                  body: {
                    idToken: payload.idToken,
                    displayName,
                    returnSecureToken: true,
                  },
                },
              );
            } catch {
              payload.displayName = displayName;
            }
          }
          const user = normalizeUser(payload);
          const session = normalizeSession(payload);
          if (
            user &&
            session &&
            requiresEmailVerification(env) &&
            !user.emailVerified
          ) {
            await sendVerificationEmail(session.access_token);
            return {
              data: { user, session: null, confirmationRequired: true },
              error: null,
            };
          }
          return {
            data: {
              user,
              session,
              confirmationRequired: false,
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async getUser(accessToken) {
        try {
          return {
            data: { user: await lookupUser(accessToken) },
            error: null,
          };
        } catch (error) {
          return { data: null, error };
        }
      },
      async refreshSession({ refresh_token }) {
        try {
          const payload = await request(SECURE_TOKEN_ORIGIN, "token", {
            form: true,
            body: {
              grant_type: "refresh_token",
              refresh_token,
            },
          });
          const session = normalizeSession(payload);
          const user = session ? await lookupUser(session.access_token) : null;
          return { data: { user, session }, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      async sendVerificationEmail(accessToken) {
        try {
          await sendVerificationEmail(accessToken);
          return { data: { sent: true }, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      async signOut() {
        // Identity Platform has no end-user REST revoke endpoint. Clearing the
        // encrypted application cookie removes the only retained refresh token.
      },
    }),
  });
}
