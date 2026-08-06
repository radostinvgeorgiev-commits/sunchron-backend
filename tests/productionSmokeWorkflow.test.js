import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("production smoke publishes a readable commit status without a custom secret", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/production-smoke.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /statuses:\s*write/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.match(workflow, /synchron\/production-smoke/u);
  assert.match(workflow, /statuses\/\$\{GITHUB_SHA\}/u);
  assert.match(workflow, /required_matches=5/u);
  assert.match(
    workflow,
    /consecutive_matches=\$\(\(consecutive_matches \+ 1\)\)/u,
  );
  assert.match(workflow, /deployment-check=\$\{GITHUB_RUN_ID\}-\$\{attempt\}/u);
  assert.match(workflow, /Cache-Control: no-cache/u);
  assert.match(workflow, /Check AI CORE public shell/u);
  assert.match(workflow, /<title>AI CORE/u);
  assert.match(workflow, /ai-core-mark\.png/u);
  assert.match(workflow, /Check MCP tool catalog and OAuth challenge/u);
  assert.match(workflow, /Check OpenSearch and Supabase dependencies/u);
  assert.match(workflow, /\/health\/dependencies/u);
  assert.match(workflow, /memoryIndexReadable/u);
  assert.match(
    workflow,
    /Check backup coverage and OpenSearch restore-point inventory/u,
  );
  assert.match(workflow, /\/health\/backups/u);
  assert.match(workflow, /provesRestore/u);
  assert.match(workflow, /report\.status !== "partially-verified"/u);
  assert.match(workflow, /backup\?\.fresh !== true/u);
  assert.match(workflow, /supabase\?\.status !== "unverified"/u);
  const backupStep = workflow
    .split(
      "- name: Check backup coverage and OpenSearch restore-point inventory",
    )[1]
    .split("- name: Check production memory acceptance")[0];
  assert.doesNotMatch(backupStep, /curl --fail/u);
  assert.match(workflow, /get_github_copilot_task_status/u);
  assert.match(workflow, /names\.length === expected\.length/u);
  assert.match(workflow, /challenge_headers/u);
  assert.match(workflow, /synchron:read/u);
  assert.match(workflow, /--dump-header -/u);
  assert.match(workflow, /--output \/dev\/null/u);
  assert.match(workflow, /\^www-authenticate:/u);
  assert.doesNotMatch(
    workflow,
    /challenge_headers="\$\(curl --fail --silent --show-error/u,
  );
  assert.doesNotMatch(workflow, /mcp\/www_authenticate/u);
  assert.match(workflow, /Check workspace authentication boundary/u);
  assert.match(workflow, /\/api\/workspaces/u);
  assert.match(workflow, /AUTH_REQUIRED/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("DigitalOcean remains the only production deployment channel", async () => {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const workflowNames = await readdir(workflowDirectory);
  const workflows = await Promise.all(
    workflowNames.map((name) =>
      readFile(new URL(name, workflowDirectory), "utf8"),
    ),
  );
  const combined = workflows.join("\n");

  assert.doesNotMatch(combined, /actions\/deploy-pages/u);
  assert.doesNotMatch(combined, /actions\/upload-pages-artifact/u);
  assert.doesNotMatch(combined, /^\s*pages:\s*write\s*$/mu);
});
