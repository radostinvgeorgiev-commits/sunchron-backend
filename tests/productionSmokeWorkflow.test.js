import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/production-smoke.yml",
  import.meta.url,
);

test("production smoke targets the canonical Google Cloud production site", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /PRODUCTION_ORIGIN: https:\/\/cloudaicore\.com/u);
  assert.match(workflow, /Wait for exact Google Cloud production commit/u);
  assert.match(workflow, /required_matches=5/u);
  assert.match(workflow, /deployment-check=\$\{GITHUB_RUN_ID\}-\$\{attempt\}/u);
  assert.match(workflow, /Cache-Control: no-cache/u);
  assert.doesNotMatch(
    workflow,
    /synchron\.foundation|DigitalOcean|Cloudflare|OpenSearch|Supabase|Copilot/iu,
  );
});

test("production smoke verifies Firestore, Identity Platform and honest backups", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /Check Firestore and Identity Platform dependencies/u);
  assert.match(workflow, /checks\.firestore\?\.status !== "healthy"/u);
  assert.match(workflow, /checks\.identityPlatform\?\.status !== "healthy"/u);
  assert.match(workflow, /provider !== "identity-platform"/u);
  assert.match(workflow, /Check honest Firestore backup boundary/u);
  assert.match(workflow, /firestore\?\.restoreTested !== false/u);
});

test("production smoke verifies the current MCP catalog and OAuth boundary", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  for (const toolName of [
    "get_google_cloud_runtime_status",
    "list_available_capabilities",
    "list_action_history",
    "list_tasks",
    "create_task_draft",
    "list_projects",
  ]) {
    assert.match(workflow, new RegExp(toolName, "u"));
  }
  assert.match(workflow, /new Set\(names\)\.size === names\.length/u);
  assert.match(workflow, /scheme\.type === "noauth"/u);
  assert.match(workflow, /get_personal_context/u);
  assert.match(workflow, /challenge_status/u);
  assert.match(workflow, /mcp\/www_authenticate/u);
  assert.match(workflow, /error=\\"invalid_token\\"/u);
  assert.match(workflow, /AUTH_REQUIRED/u);
});

test("production smoke publishes a readable commit status without custom secrets", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /statuses:\s*write/u);
  assert.match(workflow, /if:\s*always\(\)/u);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.match(workflow, /synchron\/production-smoke/u);
  assert.match(workflow, /statuses\/\$\{GITHUB_SHA\}/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("GitHub workflows do not publish through a retired deployment channel", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = await Promise.all(
    (await readdir(directory)).map((name) =>
      readFile(new URL(name, directory), "utf8"),
    ),
  );
  const combined = workflows.join("\n");
  assert.doesNotMatch(combined, /actions\/deploy-pages/u);
  assert.doesNotMatch(combined, /actions\/upload-pages-artifact/u);
  assert.doesNotMatch(combined, /^\s*pages:\s*write\s*$/mu);
});
