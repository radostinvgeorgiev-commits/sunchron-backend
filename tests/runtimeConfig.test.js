import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigValidationError,
  validateRuntimeConfig,
} from "../src/config/runtimeConfig.js";

const VALID_ENV = Object.freeze({
  OPENAI_API_KEY: "openai-secret",
  MCP_ACCESS_TOKEN: "m".repeat(48),
  AGENT_KEY: "agent-secret",
  DATABASE_URL: "postgres://db.example/internal",
  OPENSEARCH_HOST: "search.example.com",
  OPENSEARCH_PORT: "9200",
  OPENSEARCH_PROTOCOL: "https",
  OPENSEARCH_USERNAME: "memory-user",
  OPENSEARCH_PASSWORD: "memory-password",
  PORT: "8080",
});

test("runtime config validates and normalizes the server and OpenSearch settings", () => {
  const config = validateRuntimeConfig(VALID_ENV);
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 8080);
  assert.equal(config.openSearch.url, "https://search.example.com:9200");
});

test("runtime config fails closed with actionable details", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        OPENAI_API_KEY: "",
        OPENSEARCH_HOST: "bad host",
        OPENSEARCH_PORT: "99999",
      }),
    (error) =>
      error instanceof ConfigValidationError &&
      error.details.some(({ key }) => key === "OPENAI_API_KEY") &&
      error.details.some(({ key }) => key === "OPENSEARCH_HOST/PORT/PROTOCOL"),
  );
});
