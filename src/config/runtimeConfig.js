const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_OPENAI_API_URL = "https://api.openai.com/v1";
const DEFAULT_OPENSEARCH_PROTOCOL = "https";
const DEFAULT_DEBUG_LOGS = false;

export class ConfigValidationError extends Error {
  constructor(message, { code = "CONFIG_VALIDATION_FAILED", details = [] } = {}) {
    super(message);
    this.name = "ConfigValidationError";
    this.code = code;
    this.details = Object.freeze(details.slice(0, 20));
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseInteger(value, fallback, { min = 1, max = 65535 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function normalizeHostname(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) return "";
  if (/^[a-z0-9.-]+$/iu.test(host) || /^\[[a-f0-9:]+\]$/iu.test(host)) return host;
  return "";
}

function normalizeHttpUrl(value, { requireHttps = true } = {}) {
  if (!hasText(value)) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (requireHttps && url.protocol !== "https:") return "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function buildServiceUrl({ protocol, host, port }) {
  const normalizedProtocol = protocol === "http" ? "http" : "https";
  const normalizedHost = normalizeHostname(host);
  if (!normalizedHost) return "";
  const normalizedPort = parseInteger(port, NaN);
  if (!Number.isInteger(normalizedPort)) return "";
  return `${normalizedProtocol}://${normalizedHost}:${normalizedPort}`;
}

function optionalSecret(env, key) {
  return hasText(env[key]) ? env[key].trim() : "";
}

function requiredWhenEnabled(errors, env, key, enabled, message) {
  if (enabled && !hasText(env[key])) {
    errors.push({ key, message });
  }
}

export function validateRuntimeConfig(env = process.env) {
  const errors = [];
  const openSearchUrl = buildServiceUrl({
    protocol: String(env.OPENSEARCH_PROTOCOL || DEFAULT_OPENSEARCH_PROTOCOL)
      .trim()
      .toLowerCase(),
    host: env.OPENSEARCH_HOST,
    port: env.OPENSEARCH_PORT,
  });

  const openAiEnabled = hasText(env.OPENAI_API_KEY);
  const mcpEnabled = hasText(env.MCP_ACCESS_TOKEN);
  const githubEnabled =
    hasText(env.GITHUB_CLIENT_ID) || hasText(env.GITHUB_CLIENT_SECRET);
  const googleEnabled =
    hasText(env.GOOGLE_CLIENT_ID) ||
    hasText(env.GOOGLE_CLIENT_SECRET) ||
    hasText(env.GOOGLE_REDIRECT_URI);
  const supabaseEnabled =
    hasText(env.SUPABASE_URL) || hasText(env.SUPABASE_PUBLISHABLE_KEY);

  if (!openSearchUrl) {
    errors.push({
      key: "OPENSEARCH_HOST/PORT/PROTOCOL",
      message: "OpenSearch адресът трябва да е валиден host/port/protocol.",
    });
  }
  requiredWhenEnabled(
    errors,
    env,
    "OPENSEARCH_USERNAME",
    true,
    "Липсва OpenSearch потребител.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "OPENSEARCH_PASSWORD",
    true,
    "Липсва OpenSearch парола.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "OPENAI_API_KEY",
    !openAiEnabled,
    "Липсва OPENAI_API_KEY за AI разговора.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "MCP_ACCESS_TOKEN",
    !mcpEnabled,
    "Липсва MCP_ACCESS_TOKEN за bridge защитата.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "DATABASE_URL",
    !hasText(env.DATABASE_URL),
    "Липсва DATABASE_URL.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "AGENT_KEY",
    !hasText(env.AGENT_KEY),
    "Липсва AGENT_KEY.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "SUPABASE_URL",
    supabaseEnabled,
    "Липсва SUPABASE_URL.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "SUPABASE_PUBLISHABLE_KEY",
    supabaseEnabled,
    "Липсва SUPABASE_PUBLISHABLE_KEY.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "GITHUB_CLIENT_ID",
    githubEnabled,
    "Липсва GITHUB_CLIENT_ID.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "GITHUB_CLIENT_SECRET",
    githubEnabled,
    "Липсва GITHUB_CLIENT_SECRET.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "GOOGLE_CLIENT_ID",
    googleEnabled,
    "Липсва GOOGLE_CLIENT_ID.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "GOOGLE_CLIENT_SECRET",
    googleEnabled,
    "Липсва GOOGLE_CLIENT_SECRET.",
  );
  requiredWhenEnabled(
    errors,
    env,
    "GOOGLE_REDIRECT_URI",
    googleEnabled,
    "Липсва GOOGLE_REDIRECT_URI.",
  );

  const githubRedirectUrl =
    normalizeHttpUrl(env.GITHUB_REDIRECT_URI) || normalizeHttpUrl(env.GITHUB_API_URL);
  const googleRedirectUrl = normalizeHttpUrl(env.GOOGLE_REDIRECT_URI);
  const supabaseUrl = normalizeHttpUrl(env.SUPABASE_URL);
  const openAiApiUrl =
    normalizeHttpUrl(env.OPENAI_API_URL, { requireHttps: true }) ||
    DEFAULT_OPENAI_API_URL;

  if (githubEnabled && !githubRedirectUrl) {
    errors.push({
      key: "GITHUB_REDIRECT_URI",
      message: "GitHub redirect URI трябва да е валиден HTTPS адрес.",
    });
  }
  if (googleEnabled && !googleRedirectUrl) {
    errors.push({
      key: "GOOGLE_REDIRECT_URI",
      message: "Google redirect URI трябва да е валиден HTTPS адрес.",
    });
  }
  if (supabaseEnabled && !supabaseUrl) {
    errors.push({
      key: "SUPABASE_URL",
      message: "Supabase URL трябва да е валиден HTTPS адрес.",
    });
  }

  const port = parseInteger(env.PORT, DEFAULT_PORT);
  const host = hasText(env.HOST) ? env.HOST.trim() : DEFAULT_HOST;

  if (errors.length > 0) {
    throw new ConfigValidationError("Невалидна runtime конфигурация.", {
      details: errors,
    });
  }

  return Object.freeze({
    server: {
      host,
      port,
      debugLogs: parseBoolean(env.DEBUG_LOGS, DEFAULT_DEBUG_LOGS),
    },
    openSearch: {
      url: openSearchUrl,
      username: optionalSecret(env, "OPENSEARCH_USERNAME"),
      password: optionalSecret(env, "OPENSEARCH_PASSWORD"),
      tlsRejectUnauthorized:
        env.NODE_ENV === "production"
          ? true
          : !parseBoolean(env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED, false),
    },
    openAi: {
      enabled: openAiEnabled,
      apiUrl: openAiApiUrl,
    },
    bridge: {
      enabled: mcpEnabled,
      tokenConfigured: mcpEnabled,
    },
    supabase: {
      url: supabaseUrl,
    },
  });
}
