import { Client } from "@opensearch-project/opensearch";

let opensearchClient = null;
let lastMissingConfigKey = null;

function shouldWarnForMissingConfig() {
  return process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT;
}

export function createOpenSearchClient() {
  const {
    OPENSEARCH_USERNAME,
    OPENSEARCH_PASSWORD,
    OPENSEARCH_HOST,
    OPENSEARCH_PORT,
  } = process.env;
  
  if (!OPENSEARCH_USERNAME || !OPENSEARCH_PASSWORD || !OPENSEARCH_HOST || !OPENSEARCH_PORT) {
    const missing = [];
    if (!OPENSEARCH_USERNAME) missing.push("OPENSEARCH_USERNAME");
    if (!OPENSEARCH_PASSWORD) missing.push("OPENSEARCH_PASSWORD");
    if (!OPENSEARCH_HOST) missing.push("OPENSEARCH_HOST");
    if (!OPENSEARCH_PORT) missing.push("OPENSEARCH_PORT");

    const missingConfigKey = missing.join(", ");
    if (shouldWarnForMissingConfig() && lastMissingConfigKey !== missingConfigKey) {
      console.warn(`⚠️  OpenSearch credentials not configured. Missing: ${missingConfigKey}`);
      lastMissingConfigKey = missingConfigKey;
    }
    return null;
  }

  try {
    const tlsVerificationDisabled =
      process.env.NODE_ENV !== "production" &&
      process.env.OPENSEARCH_ALLOW_INSECURE_TLS === "true";
    if (tlsVerificationDisabled) {
      console.warn(
        "⚠️  OpenSearch TLS verification is disabled for non-production runtime.",
      );
    }
    opensearchClient = new Client({
      node: `https://${OPENSEARCH_HOST}:${OPENSEARCH_PORT}`,
      auth: {
        username: OPENSEARCH_USERNAME,
        password: OPENSEARCH_PASSWORD,
      },
      ssl: {
        rejectUnauthorized: !tlsVerificationDisabled,
      },
    });

    console.log("✅ OpenSearch client initialized");
    lastMissingConfigKey = null;
    return opensearchClient;
  } catch (error) {
    console.error("❌ Failed to initialize OpenSearch client:", error.message);
    return null;
  }
}

export function getOpenSearchClient() {
  if (!opensearchClient) {
    opensearchClient = createOpenSearchClient();
  }
  return opensearchClient;
}

export default getOpenSearchClient;
