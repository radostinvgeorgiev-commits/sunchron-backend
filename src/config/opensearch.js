import { Client } from "@opensearch-project/opensearch";

let opensearchClient = null;

export function createOpenSearchClient() {
  const {
    OPENSEARCH_USERNAME,
    OPENSEARCH_PASSWORD,
    OPENSEARCH_HOST,
    OPENSEARCH_PORT,
  } = process.env;
  
  if (!OPENSEARCH_USERNAME || !OPENSEARCH_PASSWORD || !OPENSEARCH_HOST || !OPENSEARCH_PORT) {
    console.warn("⚠️  OpenSearch credentials not configured. Search functionality will be limited.");
    return null;
  }

  try {
    opensearchClient = new Client({
      node: `https://${OPENSEARCH_HOST}:${OPENSEARCH_PORT}`,
      auth: {
        username: OPENSEARCH_USERNAME,
        password: OPENSEARCH_PASSWORD,
      },
      ssl: {
        rejectUnauthorized: false, // За development; за production използвай валиден сертификат
      },
    });

    console.log("✅ OpenSearch client initialized");
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
