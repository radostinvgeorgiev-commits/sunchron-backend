import { Client } from "@opensearch-project/opensearch";
import { logSafeError } from "../src/utils/safeLogging.js";

let migrationClient = null;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTlsOptions(env = process.env) {
  const explicitlyDisabled =
    String(env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED).toLowerCase() === "false";
  const isProduction = env.NODE_ENV === "production";

  if (explicitlyDisabled && isProduction) {
    console.warn(
      "OPENSEARCH_TLS_REJECT_UNAUTHORIZED=false is ignored in production.",
    );
  }

  return { rejectUnauthorized: isProduction || !explicitlyDisabled };
}

/**
 * One-time migration source only. This module is deliberately outside src/
 * so the production runtime cannot instantiate an OpenSearch client.
 */
export function createMigrationOpenSearchClient(env = process.env) {
  const {
    OPENSEARCH_USERNAME,
    OPENSEARCH_PASSWORD,
    OPENSEARCH_HOST,
    OPENSEARCH_PORT,
  } = env;

  if (
    !OPENSEARCH_USERNAME ||
    !OPENSEARCH_PASSWORD ||
    !OPENSEARCH_HOST ||
    !OPENSEARCH_PORT
  ) {
    const missing = [];
    if (!OPENSEARCH_USERNAME) missing.push("OPENSEARCH_USERNAME");
    if (!OPENSEARCH_PASSWORD) missing.push("OPENSEARCH_PASSWORD");
    if (!OPENSEARCH_HOST) missing.push("OPENSEARCH_HOST");
    if (!OPENSEARCH_PORT) missing.push("OPENSEARCH_PORT");
    console.warn(
      `OpenSearch migration source not configured. Missing: ${missing.join(", ")}`,
    );
    return null;
  }

  try {
    migrationClient = new Client({
      node: `${env.OPENSEARCH_PROTOCOL || "https"}://${OPENSEARCH_HOST}:${OPENSEARCH_PORT}`,
      auth: { username: OPENSEARCH_USERNAME, password: OPENSEARCH_PASSWORD },
      ssl: resolveTlsOptions(env),
      requestTimeout: positiveInteger(
        env.OPENSEARCH_REQUEST_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
    });
    return migrationClient;
  } catch (error) {
    logSafeError("[OpenSearch migration] Client initialization failed", error);
    return null;
  }
}

export function getMigrationOpenSearchClient(env = process.env) {
  return migrationClient || createMigrationOpenSearchClient(env);
}
