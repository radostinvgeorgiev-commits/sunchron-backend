import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const envExample = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const cloudRunTemplate = readFileSync(
  new URL("../deploy/cloud-run/service.yaml.template", import.meta.url),
  "utf8",
);

function environmentKeys(source) {
  return new Set(
    [...source.matchAll(/^([A-Z0-9_]+)=/gmu)].map((match) => match[1]),
  );
}

test("Google Cloud is the only declared runtime environment", () => {
  assert.equal(existsSync(new URL("../.do/app.yaml", import.meta.url)), false);
  assert.match(envExample, /^MEMORY_BACKEND=firestore$/mu);
  assert.match(envExample, /^PERSISTENCE_BACKEND=firestore$/mu);
  assert.match(envExample, /^AUTH_BACKEND=identity-platform$/mu);
  assert.match(envExample, /^MCP_RESOURCE_URL=https:\/\/cloudaicore\.com\/mcp$/mu);
  assert.doesNotMatch(envExample, /synchron\.foundation|DigitalOcean|Cloudflare/iu);
});

test("multi-engine code execution and protected connections are documented", () => {
  const keys = environmentKeys(envExample);
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_CODEX_MODEL",
    "GEMINI_API_KEY",
    "VERTEX_AI_ENABLED",
    "VERTEX_AI_PROJECT_ID",
    "VERTEX_AI_LOCATION",
    "VERTEX_AI_MODEL",
    "VERTEX_AI_TIMEOUT_MS",
    "GROK_API_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "MCP_ACCESS_TOKEN",
    "MCP_OAUTH_SECRET",
    "MEMORY_OWNER_ID",
  ]) {
    assert.equal(keys.has(key), true, `${key} is missing from .env.example`);
  }
  assert.doesNotMatch(envExample, /OPENAI_API_KEY=\S+/u);
  assert.doesNotMatch(envExample, /GEMINI_API_KEY=\S+/u);
  assert.doesNotMatch(envExample, /GROK_API_KEY=\S+/u);
  assert.match(envExample, /^VERTEX_AI_ENABLED=false$/mu);
  assert.match(envExample, /^VERTEX_AI_LOCATION=us-central1$/mu);
  assert.match(envExample, /^VERTEX_AI_MODEL=gemini-2\.5-flash$/mu);
});

test("Cloud Run binds all three AI engines through Secret Manager", () => {
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GROK_API_KEY"]) {
    assert.match(cloudRunTemplate, new RegExp(`name: ${key}\\s+valueFrom:`, "u"));
  }
  assert.match(cloudRunTemplate, /run\.googleapis\.com\/secrets:/u);
  assert.match(cloudRunTemplate, /name: MEMORY_BACKEND\s+value: firestore/u);
  assert.match(
    cloudRunTemplate,
    /name: AUTH_BACKEND\s+value: identity-platform/u,
  );
});
