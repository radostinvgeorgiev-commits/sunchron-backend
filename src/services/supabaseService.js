import {
  normalizeTesterAuthPublishableKey,
  resolveTesterAuthConnection,
} from "../config/testerAuthBootstrap.js";

const DEFAULT_TIMEOUT_MS = 10000;

export class SupabaseServiceError extends Error {
  constructor(message, status = 503, code = "SUPABASE_UNAVAILABLE") {
    super(message);
    this.name = "SupabaseServiceError";
    this.status = status;
    this.code = code;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProjectUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SupabaseServiceError(
      "Supabase не е конфигуриран.",
      503,
      "SUPABASE_NOT_CONFIGURED",
    );
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SupabaseServiceError(
      "Supabase адресът е невалиден.",
      503,
      "SUPABASE_INVALID_URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new SupabaseServiceError(
      "Supabase връзката трябва да използва HTTPS.",
      503,
      "SUPABASE_INSECURE_URL",
    );
  }
  return url.origin;
}

export async function checkSupabaseStatus(options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs,
    env = process.env,
  } = options;
  const hasProjectUrl = Object.hasOwn(options, "projectUrl");
  const hasPublishableKey = Object.hasOwn(options, "publishableKey");
  if (hasProjectUrl !== hasPublishableKey) {
    throw new SupabaseServiceError(
      "Supabase връзката трябва да съдържа адрес и публичен ключ.",
      503,
      "SUPABASE_NOT_CONFIGURED",
    );
  }
  const connection = hasProjectUrl
    ? {
        projectUrl: options.projectUrl,
        publishableKey: options.publishableKey,
        connectionSource: "explicit",
      }
    : resolveTesterAuthConnection(env);
  const url = normalizeProjectUrl(connection.projectUrl);
  const resolvedPublishableKey = normalizeTesterAuthPublishableKey(
    connection.publishableKey,
  );
  if (!resolvedPublishableKey) {
    throw new SupabaseServiceError(
      "Supabase ключът за достъп не е конфигуриран.",
      503,
      "SUPABASE_NOT_CONFIGURED",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    parsePositiveInteger(
      timeoutMs ?? env.SUPABASE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
  );
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(`${url}/auth/v1/settings`, {
      method: "GET",
      headers: {
        apikey: resolvedPublishableKey.trim(),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SupabaseServiceError(
        `Supabase API върна грешка ${response.status}.`,
        502,
        "SUPABASE_UPSTREAM_ERROR",
      );
    }
    return Object.freeze({
      status: "healthy",
      service: "Supabase API",
      responseTimeMs: Date.now() - startedAt,
      connectionSource: connection.connectionSource,
    });
  } catch (error) {
    if (error instanceof SupabaseServiceError) throw error;
    if (error?.name === "AbortError") {
      throw new SupabaseServiceError(
        "Supabase не отговори навреме.",
        504,
        "SUPABASE_TIMEOUT",
      );
    }
    throw new SupabaseServiceError(
      "Supabase временно не е достъпен.",
      503,
      "SUPABASE_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}
