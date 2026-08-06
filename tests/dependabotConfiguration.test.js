import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("Dependabot proposes one grouped weekly npm update for main", async () => {
  const configuration = await readFile(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf8",
  );

  assert.match(configuration, /^version:\s*2\s*$/mu);
  assert.match(configuration, /^\s*- package-ecosystem:\s*["']?npm["']?\s*$/mu);
  assert.match(configuration, /^\s*directory:\s*["']?\/["']?\s*$/mu);
  assert.match(configuration, /^\s*target-branch:\s*["']?main["']?\s*$/mu);
  assert.match(configuration, /^\s*interval:\s*["']?weekly["']?\s*$/mu);
  assert.match(configuration, /^\s*timezone:\s*["']?Europe\/Sofia["']?\s*$/mu);
  assert.match(configuration, /^\s*open-pull-requests-limit:\s*1\s*$/mu);
  assert.match(configuration, /^\s*all-npm-dependencies:\s*$/mu);
  assert.match(
    configuration,
    /^\s*applies-to:\s*["']?version-updates["']?\s*$/mu,
  );
  assert.match(configuration, /^\s*patterns:\s*\n\s*-\s*["']\*["']\s*$/mu);
  assert.doesNotMatch(configuration, /^\s*dependency-type:/mu);
  assert.doesNotMatch(configuration, /\b(?:auto-?merge|deploy(?:ment)?)\b/iu);
});

test("dependency updates cannot auto-merge or deploy from a workflow", async () => {
  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  const workflowNames = await readdir(workflowDirectory);
  const workflows = await Promise.all(
    workflowNames.map((name) =>
      readFile(new URL(name, workflowDirectory), "utf8"),
    ),
  );
  const combined = workflows.join("\n");

  assert.doesNotMatch(combined, /gh\s+pr\s+merge\b/iu);
  assert.doesNotMatch(combined, /enablePullRequestAutoMerge/iu);
  assert.doesNotMatch(combined, /enable-pull-request-automerge/iu);
  assert.doesNotMatch(combined, /dependabot[-_/ ]?automerge/iu);
  assert.doesNotMatch(combined, /automerge-action/iu);
});
