import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(workflow, /get_github_copilot_task_status/u);
  assert.match(workflow, /names\.length === expected\.length/u);
  assert.match(workflow, /challenge_status/u);
  assert.match(workflow, /test "\$\{challenge_status\}" = "401"/u);
  assert.match(workflow, /www-authenticate:/u);
  assert.match(workflow, /oauth-protected-resource/u);
  assert.match(workflow, /error\?\.code === -32001/u);
  assert.match(workflow, /synchron:read/u);
  assert.match(workflow, /Check workspace authentication boundary/u);
  assert.match(workflow, /\/api\/workspaces/u);
  assert.match(workflow, /AUTH_REQUIRED/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});
