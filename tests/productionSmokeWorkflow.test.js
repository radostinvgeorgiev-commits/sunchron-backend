import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import test from "node:test";

function bashEnvironment() {
  return {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  };
}

function runBash(script, args = ["-s"]) {
  return spawnSync("bash", args, {
    input: script,
    encoding: "utf8",
    env: bashEnvironment(),
  });
}

function extractMcpChallengeStep(workflow) {
  const namedStep = workflow.split(
    "- name: Check MCP tool catalog and OAuth challenge",
  )[1];
  assert.ok(namedStep, "MCP OAuth challenge step is missing");
  const block = namedStep.split(/^      - name:/mu)[0];
  const run = block.split(/        run: \|\r?\n/u)[1];
  assert.ok(run, "MCP OAuth challenge bash block is missing");
  return run.replace(/^ {10}/gmu, "").trimEnd();
}

function extractChallengeValidator(step) {
  const start = step.lastIndexOf("node -e '");
  const endMarker = `' "\${challenge_body}"`;
  const end = step.indexOf(endMarker, start);
  assert.notEqual(start, -1, "challenge validator is missing");
  assert.notEqual(end, -1, "challenge validator argument is missing");
  return step.slice(start, end + endMarker.length);
}

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
  assert.match(workflow, /\/health\/storage-report/u);
  assert.match(workflow, /memoryIndexReadable/u);
  const dependencyStep = workflow
    .split("- name: Check OpenSearch and Supabase dependencies")[1]
    .split(
      "- name: Check backup coverage and OpenSearch restore-point inventory",
    )[0];
  assert.match(dependencyStep, /dependencies_healthy=false/u);
  assert.match(dependencyStep, /for attempt in 1 2 3/u);
  assert.match(dependencyStep, /"runtime"/u);
  assert.match(dependencyStep, /"public-bootstrap"/u);
  assert.match(dependencyStep, /connectionSource/u);
  assert.match(dependencyStep, /allowedSupabaseSources\.has/u);
  assert.match(dependencyStep, /test "\$\{dependencies_healthy\}" = "true"/u);
  assert.match(
    workflow,
    /Check backup coverage and OpenSearch restore-point inventory/u,
  );
  assert.match(workflow, /JSON\.parse\(input\)\.backups/u);
  assert.match(workflow, /provesRestore/u);
  assert.match(workflow, /report\.status !== "partially-verified"/u);
  assert.match(workflow, /backup\?\.fresh !== true/u);
  assert.match(workflow, /supabase\?\.status !== "unverified"/u);
  const backupStep = workflow
    .split(
      "- name: Check backup coverage and OpenSearch restore-point inventory",
    )[1]
    .split("- name: Check production memory acceptance")[0];
  assert.match(backupStep, /curl --fail/u);
  assert.match(backupStep, /if response="\$\(curl --fail/u);
  assert.match(workflow, /get_github_copilot_task_status/u);
  for (const toolName of [
    "list_available_capabilities",
    "list_action_history",
    "list_tasks",
    "create_task_draft",
    "list_projects",
  ]) {
    assert.match(workflow, new RegExp(toolName, "u"));
  }
  assert.match(workflow, /names\.length >= expected\.length/u);
  assert.match(workflow, /new Set\(names\)\.size === names\.length/u);
  assert.match(workflow, /expected\.every\(\(name\) => names\.includes\(name\)\)/u);
  assert.doesNotMatch(workflow, /names\.length === expected\.length/u);
  assert.match(workflow, /synchron:audit\.read/u);
  assert.match(workflow, /synchron:tasks\.write/u);
  assert.match(workflow, /challenge_headers="\$\(mktemp\)"/u);
  assert.match(workflow, /challenge_body="\$\(mktemp\)"/u);
  assert.match(workflow, /challenge_status/u);
  assert.match(workflow, /synchron:read/u);
  assert.match(workflow, /--dump-header "\$\{challenge_headers\}"/u);
  assert.match(workflow, /--output "\$\{challenge_body\}"/u);
  assert.match(workflow, /--write-out '%\{http_code\}'/u);
  assert.match(workflow, /\^www-authenticate:/u);
  assert.match(workflow, /mcp\/www_authenticate/u);
  assert.match(workflow, /result\?\.isError === true/u);
  assert.match(
    workflow,
    /challenge\.includes\("error=\\"invalid_token\\""\)/u,
  );
  assert.match(workflow, /challenge\.includes\("error_description=\\""\)/u);
  assert.doesNotMatch(workflow, /challenge\.includes\('error=/u);
  assert.match(workflow, /Check workspace authentication boundary/u);
  assert.match(workflow, /\/api\/workspaces/u);
  assert.match(workflow, /AUTH_REQUIRED/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("MCP OAuth challenge validator is valid and executable bash", async (t) => {
  const workflow = await readFile(
    new URL("../.github/workflows/production-smoke.yml", import.meta.url),
    "utf8",
  );
  const step = extractMcpChallengeStep(workflow);
  const probe = runBash("command -v node >/dev/null 2>&1\n");
  if (probe.error?.code === "ENOENT" || probe.status !== 0) {
    t.skip("bash with Node.js is unavailable in this environment");
    return;
  }

  const syntax = runBash(step, ["-n"]);
  assert.equal(
    syntax.status,
    0,
    `MCP challenge step is not valid bash:\n${syntax.stderr}`,
  );

  const validator = extractChallengeValidator(step);
  const challenge =
    'Bearer resource_metadata="https://synchron.foundation/.well-known/oauth-protected-resource", scope="synchron:read", error="invalid_token", error_description="Invalid token"';
  const response = JSON.stringify({
    result: {
      content: [{ type: "text", text: "OAuth входът е необходим." }],
      _meta: { "mcp/www_authenticate": [challenge] },
      isError: true,
    },
  });
  const executableScript = `set -euo pipefail
challenge_body="$(mktemp)"
trap 'rm -f "\${challenge_body}"' EXIT
cat > "\${challenge_body}" <<'JSON'
${response}
JSON
${validator}
`;
  const execution = runBash(executableScript);
  assert.equal(
    execution.status,
    0,
    `MCP challenge validator cannot execute:\n${execution.stderr}`,
  );

  const oldBrokenValidator = validator.replace(
    'challenge.includes("error=\\"invalid_token\\"")',
    `challenge.includes('error="invalid_token"')`,
  );
  assert.notEqual(oldBrokenValidator, validator);
  const brokenExecution = runBash(
    executableScript.replace(validator, oldBrokenValidator),
  );
  assert.notEqual(
    brokenExecution.status,
    0,
    "the executable test must detect the former single-quote defect",
  );
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
