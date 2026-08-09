import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const readme = read("../README.md");
const agentInstructions = read("../AGENTS.md");
const runbook = read("../docs/OPERATIONS_RUNBOOK.md");
const ownerAcceptanceRunbook = read("../docs/OWNER_ACCEPTANCE_RUNBOOK.md");
const currentAcceptance = read("../docs/CURRENT_PRODUCT_ACCEPTANCE.md");
const productDirection = read("../docs/PRODUCT_DIRECTION.md");
const architecture = read("../docs/SYNCHRON-X-V3-ARCHITECTURE.md");
const bridgeRunbook = read("../docs/BRIDGE_AND_DIAGNOSTICS.md");
const googleCloudCatalog = read(
  "../docs/GOOGLE_CLOUD_CONFIGURATION_CATALOG.md",
);
const historicalAudit = read("../docs/archive/TECHNICAL_AUDIT_2026-07.md");
const historicalShortAudit = read(
  "../docs/archive/TECHNICAL_AUDIT_2026-07-31.md",
);

test("current documentation names the real chat provider and operations source", () => {
  assert.match(readme, /OpenAI Responses API/u);
  assert.doesNotMatch(readme, /DigitalOcean AI Agent → AI model/u);
  assert.match(readme, /docs\/OPERATIONS_RUNBOOK\.md/u);
  assert.match(readme, /docs\/CURRENT_PRODUCT_ACCEPTANCE\.md/u);
  assert.match(
    architecture,
    /OpenAI Responses API е доставчикът по подразбиране/u,
  );
  assert.match(architecture, /Gemini, Grok от xAI и Anthropic/u);
  assert.match(architecture, /DigitalOcean App Platform само хоства/u);
  assert.doesNotMatch(
    architecture,
    /DigitalOcean AI Agent за основния разговор/u,
  );
});

test("agent instructions use live verification instead of a frozen deploy SHA", () => {
  assert.match(agentInstructions, /docs\/OPERATIONS_RUNBOOK\.md/u);
  assert.match(agentInstructions, /docs\/CURRENT_PRODUCT_ACCEPTANCE\.md/u);
  assert.match(agentInstructions, /synchron\/production-smoke/u);
  assert.doesNotMatch(
    agentInstructions,
    /`main` и production са на commit `[a-f0-9]+`/u,
  );
});

test("operations runbook keeps rollback and destructive boundaries explicit", () => {
  for (const marker of [
    "/health/ready",
    "/health/dependencies",
    "/health/backups",
    "memoryAcceptance",
    "synchron/production-smoke",
    "git revert",
    "не стартирай restore/fork",
  ]) {
    assert.match(runbook, new RegExp(marker, "u"));
  }
  assert.match(
    runbook,
    /не доказват, че нов\s+потребител реално може да се регистрира/u,
  );
  assert.doesNotMatch(runbook, /rm\s+-rf|git\s+push\s+--force/u);
});

test("owner acceptance is repeatable, exact and never an unattended write", () => {
  assert.match(runbook, /OWNER_ACCEPTANCE_RUNBOOK\.md/u);

  for (const marker of [
    "https://synchron.foundation/mcp",
    "get_system_configuration",
    "COPILOT_AUTOMATION_DISABLED",
    "GitHub / negative-control / passed",
    "GitHub write е отделен extended acceptance",
    "GitHub read adapter-ът използва сървърния read достъп/публичния API",
    "GITHUB_PROMPT_NOT_SHOWN",
    "Потвърждавам календарно събитие:",
    "CALENDAR_TARGET_NOT_SHOWN",
    "prepare → преглед на въздействието → точно потвърждение → execute → verify → cleanup",
    "Не стартирай write acceptance от CI",
  ]) {
    assert.match(ownerAcceptanceRunbook, new RegExp(marker, "u"));
  }

  assert.doesNotMatch(
    ownerAcceptanceRunbook,
    /Authorization:\s*Bearer|MCP_ACCESS_TOKEN\s*=|refresh_token\s*=/u,
  );
});

test("current acceptance separates verified state, blockers and explicit approvals", () => {
  for (const marker of [
    "/health/dependencies",
    "/health/backups",
    "3 реални OpenSearch restore точки",
    "restore не е тестван",
    "реална регистрация",
    "Last backup: No backups",
    "Free Plan",
    "платен Pro plan",
    "Действия само с изрично разрешение",
  ]) {
    assert.match(currentAcceptance, new RegExp(marker, "u"));
  }

  assert.match(currentAcceptance, /Supabase backup.*няма/su);
  assert.match(currentAcceptance, /merge в `main` и production deployment/u);
  assert.match(currentAcceptance, /PRODUCT_DIRECTION\.md/u);
});

test("Google Cloud foundation stays planning-only and preserves production boundaries", () => {
  for (const document of [readme, runbook, currentAcceptance]) {
    assert.match(
      document,
      /GOOGLE_CLOUD_CONFIGURATION_CATALOG\.md/u,
    );
  }

  for (const marker of [
    "OpenSearch остава authoritative",
    "Supabase остава authoritative",
    "Cloud Run",
    "Firestore",
    "Identity Platform",
    "Vertex AI",
    "няма secret",
    "DNS",
    "data migration",
  ]) {
    assert.match(googleCloudCatalog, new RegExp(marker, "u"));
  }

  assert.match(
    googleCloudCatalog,
    /Не се provision-ва и не заменя OpenSearch/u,
  );
  assert.match(
    googleCloudCatalog,
    /Няма миграция на\s+Supabase users/u,
  );
});

test("product direction keeps UX ambition separate from verified tools", () => {
  for (const marker of [
    "Център за действие",
    "Предложи → одобри → изпълни → провери",
    "memory.write_confirmed",
    "approval.confirm",
    "Microsoft Playwright MCP",
    "GitHub MCP Server",
    "Sentry MCP",
    "Context7",
    "Microsoft MarkItDown",
    "n8n",
    "read-only по подразбиране",
    "не означава внедрена или работеща production\\s+интеграция",
  ]) {
    assert.match(productDirection, new RegExp(marker, "u"));
  }

  assert.match(readme, /docs\/PRODUCT_DIRECTION\.md/u);
  assert.match(agentInstructions, /docs\/PRODUCT_DIRECTION\.md/u);
  assert.doesNotMatch(productDirection, /AI CORE прави всичко вместо теб/u);
});

test("MCP transport is not documented as a Cloudflare tunnel or backup mechanism", () => {
  assert.match(bridgeRunbook, /Той не е Cloudflare Tunnel/u);
  assert.match(bridgeRunbook, /Backup и restore не са bridge операции/u);
  assert.match(bridgeRunbook, /изрично разрешение/u);
});

test("old technical audits are archived and clearly not the current roadmap", () => {
  for (const audit of [historicalAudit, historicalShortAudit]) {
    assert.match(audit, /Исторически документ — не е текущ roadmap/u);
    assert.match(audit, /\.\.\/CURRENT_PRODUCT_ACCEPTANCE\.md/u);
  }

  assert.equal(
    existsSync(new URL("../docs/TECHNICAL_AUDIT_2026-07.md", import.meta.url)),
    false,
  );
  assert.equal(
    existsSync(
      new URL("../docs/TECHNICAL_AUDIT_2026-07-31.md", import.meta.url),
    ),
    false,
  );
});
