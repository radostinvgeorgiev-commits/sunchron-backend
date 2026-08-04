import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { getEnvironmentCatalog } from "../src/config/environmentCatalog.js";

const appSpec = readFileSync(
  new URL("../.do/app.yaml", import.meta.url),
  "utf8",
);
const envExample = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

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

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  });
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
    "CLOUDFLARE_API_TOKEN",
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

test("documented runtime variables stay present in the safe inventory", () => {
  const catalogKeys = new Set(getEnvironmentCatalog().map((item) => item.key));
  const documentedKeys = exampleEnvironmentKeys(envExample);

  for (const key of documentedKeys) {
    assert.equal(
      catalogKeys.has(key),
      true,
      `${key} is documented but missing from the environment catalog`,
    );
  }

  for (const key of ["MCP_ALLOWED_ORIGINS", "WORKSPACE_STATE_INDEX"]) {
    assert.equal(
      documentedKeys.has(key),
      true,
      `${key} is used at runtime but missing from .env.example`,
    );
  }
});

test("source environment reads stay present in the safe inventory", () => {
  const catalogKeys = new Set(getEnvironmentCatalog().map((item) => item.key));
  const platformKeys = new Set(["LANG", "PATH"]);
  const sourceFiles = [
    ...javascriptFiles(join(projectRoot, "src")),
    join(projectRoot, "server.js"),
  ];

  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:process\.)?env\.([A-Z][A-Z0-9_]+)/gu,
    )) {
      const key = match[1];
      assert.equal(
        platformKeys.has(key) || catalogKeys.has(key),
        true,
        `${key} is read by ${file} but missing from the environment catalog`,
      );
    }
  }
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
