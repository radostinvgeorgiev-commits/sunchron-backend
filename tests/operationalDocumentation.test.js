import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const readme = read("../README.md");
const agentInstructions = read("../AGENTS.md");
const runbook = read("../docs/OPERATIONS_RUNBOOK.md");
const ownerAcceptanceRunbook = read("../docs/OWNER_ACCEPTANCE_RUNBOOK.md");

test("current documentation names the real chat provider and operations source", () => {
  assert.match(readme, /OpenAI Responses API/u);
  assert.doesNotMatch(readme, /DigitalOcean AI Agent → AI model/u);
  assert.match(readme, /docs\/OPERATIONS_RUNBOOK\.md/u);
});

test("agent instructions use live verification instead of a frozen deploy SHA", () => {
  assert.match(agentInstructions, /docs\/OPERATIONS_RUNBOOK\.md/u);
  assert.match(agentInstructions, /synchron\/production-smoke/u);
  assert.doesNotMatch(
    agentInstructions,
    /`main` и production са на commit `[a-f0-9]+`/u,
  );
});

test("operations runbook keeps rollback and destructive boundaries explicit", () => {
  for (const marker of [
    "/health/ready",
    "memoryAcceptance",
    "synchron/production-smoke",
    "git revert",
    "не стартирай restore/fork",
  ]) {
    assert.match(runbook, new RegExp(marker, "u"));
  }
  assert.doesNotMatch(runbook, /rm\s+-rf|git\s+push\s+--force/u);
});

test("owner acceptance is repeatable, exact and never an unattended write", () => {
  assert.match(runbook, /OWNER_ACCEPTANCE_RUNBOOK\.md/u);

  for (const marker of [
    "https://synchron.foundation/mcp",
    "get_system_configuration",
    "COPILOT_AUTOMATION_DISABLED",
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
