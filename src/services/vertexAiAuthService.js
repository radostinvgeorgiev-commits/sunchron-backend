import { GoogleAuth } from "google-auth-library";

export const GOOGLE_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";

export class VertexAiAuthError extends Error {
  constructor(
    message,
    code = "VERTEX_AI_AUTH_UNAVAILABLE",
    status = 503,
  ) {
    super(message);
    this.name = "VertexAiAuthError";
    this.code = code;
    this.status = status;
  }
}

function createDefaultGoogleAuth() {
  return new GoogleAuth({
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
  });
}

export function normalizeVertexAiAuthorizationHeader(value) {
  if (typeof value !== "string") {
    throw new VertexAiAuthError(
      "Vertex AI удостоверяването върна невалиден отговор.",
      "VERTEX_AI_AUTH_INVALID",
      503,
    );
  }
  const match = /^Bearer[ \t]+(\S+)$/u.exec(value);
  if (
    !match ||
    match[0] !== value ||
    /[\u0000-\u001f\u007f]/u.test(match[1])
  ) {
    throw new VertexAiAuthError(
      "Vertex AI удостоверяването върна невалиден отговор.",
      "VERTEX_AI_AUTH_INVALID",
      503,
    );
  }
  return `Bearer ${match[1]}`;
}

function authorizationHeaderFromHeaders(headers) {
  const authorization =
    headers?.Authorization ||
    headers?.authorization ||
    (typeof headers?.get === "function" ? headers.get("authorization") : null);
  return normalizeVertexAiAuthorizationHeader(authorization);
}

async function getAuthorizationHeader(client, url) {
  if (typeof client?.getRequestHeaders === "function") {
    return authorizationHeaderFromHeaders(await client.getRequestHeaders(url));
  }

  if (typeof client?.getAccessToken === "function") {
    const result = await client.getAccessToken();
    const token = typeof result === "string" ? result : result?.token;
    if (typeof token !== "string" || !token.trim()) {
      throw new VertexAiAuthError(
        "Vertex AI удостоверяването не върна access token.",
        "VERTEX_AI_AUTH_INVALID",
        503,
      );
    }
    return normalizeVertexAiAuthorizationHeader(`Bearer ${token.trim()}`);
  }

  throw new VertexAiAuthError(
    "Vertex AI auth client-ът не поддържа защитени заявки.",
    "VERTEX_AI_AUTH_INVALID",
    503,
  );
}

export function createVertexAiAuthProvider({
  authFactory = createDefaultGoogleAuth,
} = {}) {
  let clientPromise = null;

  async function getClient() {
    if (!clientPromise) {
      clientPromise = Promise.resolve()
        .then(() => authFactory())
        .then((auth) => {
          if (!auth || typeof auth.getClient !== "function") {
            throw new VertexAiAuthError(
              "Vertex AI auth фабриката върна невалиден клиент.",
              "VERTEX_AI_AUTH_INVALID",
              503,
            );
          }
          return auth.getClient();
        });
    }
    return clientPromise;
  }

  return Object.freeze({
    async getRequestHeaders(url) {
      try {
        return {
          Authorization: await getAuthorizationHeader(await getClient(), url),
        };
      } catch (error) {
        clientPromise = null;
        if (error instanceof VertexAiAuthError) throw error;
        throw new VertexAiAuthError(
          "Vertex AI удостоверяването не е достъпно чрез Application Default Credentials.",
          "VERTEX_AI_AUTH_UNAVAILABLE",
          503,
        );
      }
    },
  });
}

let defaultAuthProvider;

export function getVertexAiAuthProvider() {
  if (!defaultAuthProvider) {
    defaultAuthProvider = createVertexAiAuthProvider();
  }
  return defaultAuthProvider;
}
