import { Client } from "@opensearch-project/opensearch";
import { validateRuntimeConfig } from "./runtimeConfig.js";
import { logSafeError } from "../utils/safeLogging.js";

let opensearchClient = null;

export function resolveOpenSearchTlsOptions(env = process.env) {
  const explicitlyDisabled =
    String(env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED).toLowerCase() === "false";
  const isProduction = env.NODE_ENV === "production";

  if (explicitlyDisabled && isProduction) {
    console.warn(
      "⚠️  OPENSEARCH_TLS_REJECT_UNAUTHORIZED=false is ignored in production.",
    );
  }

  return {
    rejectUnauthorized: isProduction || !explicitlyDisabled,
  };
}

export function createOpenSearchClient() {
  try {
    const config = validateRuntimeConfig(process.env);
    opensearchClient = new Client({
      node: config.openSearch.url,
      auth: {
        username: config.openSearch.username,
        password: config.openSearch.password,
      },
      ssl: {
        ...resolveOpenSearchTlsOptions(process.env),
        rejectUnauthorized: config.openSearch.tlsRejectUnauthorized,
      },
    });

    console.log("✅ OpenSearch client initialized");
    return opensearchClient;
  } catch (error) {
    logSafeError("[OpenSearch] Client initialization failed", error);
    return null;
  }
}

export function getOpenSearchClient() {
  if (!opensearchClient) {
    opensearchClient = createOpenSearchClient();
  }
  return opensearchClient;
}

export function setOpenSearchClientForTests(client) {
  opensearchClient = client;
}

export default getOpenSearchClient;
