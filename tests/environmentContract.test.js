import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSpec = readFileSync(
  new URL("../.do/app.yaml", import.meta.url),
  "utf8",
);
const envExample = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
);

function appSpecEnvironmentKeys(source) {
  return new Set(
    [...source.matchAll(/^\s+- key:\s*([A-Z0-9_]+)\s*$/gmu)].map(
      (match) => match[1],
    ),
  );
}

function exampleEnvironmentKeys(source) {
  return new Set(
    [...source.matchAll(/^([A-Z0-9_]+)=/gmu)].map((match) => match[1]),
  );
}

function appSpecKeyBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- key: ${key}`);
  assert.notEqual(start, -1, `${key} must exist in .do/app.yaml`);

  const end = lines.findIndex(
    (line, index) => index > start && /^\s+- key:/u.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

test("required MCP and memory variables stay declared in DigitalOcean", () => {
  const keys = appSpecEnvironmentKeys(appSpec);

  for (const key of [
    "MCP_ACCESS_TOKEN",
    "MCP_OAUTH_SECRET",
    "MEMORY_OWNER_ID",
  ]) {
    assert.equal(keys.has(key), true, `${key} is missing from .do/app.yaml`);

    const block = appSpecKeyBlock(appSpec, key);
    assert.match(block, /^\s*type:\s*SECRET\s*$/mu);
    assert.doesNotMatch(block, /^\s*value:/mu);
  }

  const resourceBlock = appSpecKeyBlock(appSpec, "MCP_RESOURCE_URL");
  assert.match(
    resourceBlock,
    /^\s*value:\s*https:\/\/synchron\.foundation\/mcp\s*$/mu,
  );
});

test("bridge variables stay documented without real secret values", () => {
  const keys = exampleEnvironmentKeys(envExample);
  const documentedKeys = [
    "MCP_ACCESS_TOKEN",
    "MCP_OAUTH_SECRET",
    "MCP_RESOURCE_URL",
    "MEMORY_OWNER_ID",
    "DIGITALOCEAN_API_TOKEN",
    "DIGITALOCEAN_TOKEN",
    "DIGITALOCEAN_APP_ID",
    "DIGITALOCEAN_API_URL",
    "OPENSEARCH_DATABASE_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ZONE_NAME",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_API_URL",
  ];

  for (const key of documentedKeys) {
    assert.equal(keys.has(key), true, `${key} is missing from .env.example`);
  }

  for (const key of [
    "DIGITALOCEAN_API_TOKEN",
    "DIGITALOCEAN_TOKEN",
    "CLOUDFLARE_API_TOKEN",
  ]) {
    assert.match(envExample, new RegExp(`^${key}=$`, "mu"));
  }
});

test("server-side infrastructure diagnostics are declared without values", () => {
  for (const key of ["DIGITALOCEAN_API_TOKEN", "CLOUDFLARE_API_TOKEN"]) {
    const block = appSpecKeyBlock(appSpec, key);
    assert.match(block, /^\s*type:\s*SECRET\s*$/mu);
    assert.doesNotMatch(block, /^\s*value:/mu);
  }

  const zoneName = appSpecKeyBlock(appSpec, "CLOUDFLARE_ZONE_NAME");
  assert.match(zoneName, /^\s*value:\s*synchron\.foundation\s*$/mu);
});

test("Copilot automation stays explicitly disabled by default", () => {
  const appSpecBlock = appSpecKeyBlock(appSpec, "COPILOT_AUTOMATION_ENABLED");
  assert.match(appSpecBlock, /^\s*value:\s*["']?false["']?\s*$/mu);
  assert.match(envExample, /^COPILOT_AUTOMATION_ENABLED=false$/mu);
});

test("DigitalOcean app id uses the platform-provided UUID", () => {
  const block = appSpecKeyBlock(appSpec, "DIGITALOCEAN_APP_ID");
  assert.match(block, /^\s*value:\s*\$\{APP_ID\}\s*$/mu);
  assert.match(block, /^\s*scope:\s*RUN_TIME\s*$/mu);
});
