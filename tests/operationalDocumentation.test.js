import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const readme = read("../README.md");
const agentInstructions = read("../AGENTS.md");
const runbook = read("../docs/OPERATIONS_RUNBOOK.md");
const ownerRunbook = read("../docs/OWNER_ACCEPTANCE_RUNBOOK.md");
const acceptance = read("../docs/CURRENT_PRODUCT_ACCEPTANCE.md");
const direction = read("../docs/PRODUCT_DIRECTION.md");
const architecture = read("../docs/SYNCHRON-X-V3-ARCHITECTURE.md");
const bridge = read("../docs/BRIDGE_AND_DIAGNOSTICS.md");
const catalog = read("../docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md");

test("current documentation describes one Google Cloud production architecture", () => {
  const current = [
    readme,
    agentInstructions,
    runbook,
    ownerRunbook,
    acceptance,
    architecture,
    bridge,
    catalog,
  ].join("\n");
  assert.match(current, /https:\/\/cloudaicore\.com/u);
  assert.match(current, /Cloud Run/u);
  assert.match(current, /Firestore/u);
  assert.match(current, /Identity Platform/u);
  assert.doesNotMatch(current, /synchron\.foundation|DigitalOcean|Cloudflare/iu);
});

test("code task documentation preserves multi-engine and confirmation boundaries", () => {
  for (const marker of [
    "OpenAI",
    "Gemini",
    "Grok",
    "Task Orchestrator",
    "branch",
    "commit",
    "Pull Request",
    "точно еднократно потвърждение",
  ]) {
    assert.match(`${readme}\n${architecture}\n${ownerRunbook}`, new RegExp(marker, "u"));
  }
  assert.match(ownerRunbook, /Потвърждавам AI CORE кодова задача:/u);
  assert.match(ownerRunbook, /Не стартирай write\s+acceptance от CI/u);
});

test("operations keep exact-SHA, rollback and destructive boundaries explicit", () => {
  for (const marker of [
    "/health/ready",
    "/health/dependencies",
    "/health/backups",
    "synchron/production-smoke",
    "git revert",
    "[Нн]е стартирай restore/fork",
  ]) {
    assert.match(`${runbook}\n${agentInstructions}`, new RegExp(marker, "u"));
  }
  assert.doesNotMatch(runbook, /rm\s+-rf|git\s+push\s+--force/u);
});

test("MCP documentation separates transport, tools and backup verification", () => {
  assert.match(bridge, /https:\/\/cloudaicore\.com\/mcp/u);
  assert.match(bridge, /get_google_cloud_runtime_status/u);
  assert.match(bridge, /Backup и restore не са bridge операции/u);
  assert.match(bridge, /изрично разрешение/u);
});

test("product direction remains ambition rather than verified runtime", () => {
  assert.match(direction, /Център за действие/u);
  assert.match(direction, /read-only по подразбиране/u);
  assert.match(direction, /не означава внедрена или работеща production\s+интеграция/u);
});

test("historical audits remain archived and are not the current roadmap", () => {
  for (const name of [
    "TECHNICAL_AUDIT_2026-07.md",
    "TECHNICAL_AUDIT_2026-07-31.md",
  ]) {
    const audit = read(`../docs/archive/${name}`);
    assert.match(audit, /Исторически документ — не е текущ roadmap/u);
    assert.equal(existsSync(new URL(`../docs/${name}`, import.meta.url)), false);
  }
});
