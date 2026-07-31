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
  assert.match(workflow, /Check MCP tool catalog and OAuth challenge/u);
  assert.match(workflow, /get_github_copilot_task_status/u);
  assert.match(workflow, /names\.length === expected\.length/u);
  assert.match(workflow, /mcp\/www_authenticate/u);
  assert.match(workflow, /synchron:read/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});
