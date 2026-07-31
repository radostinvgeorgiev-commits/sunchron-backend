import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("repository-wide Copilot instructions preserve the project safety contract", async () => {
  const instructions = await readFile(
    new URL("../.github/copilot-instructions.md", import.meta.url),
    "utf8",
  );

  assert.match(instructions, /AGENTS\.md/u);
  assert.match(instructions, /npm ci/u);
  assert.match(instructions, /npm test/u);
  assert.match(instructions, /npm audit --omit=dev --audit-level=high/u);
  assert.match(instructions, /separate branch/u);
  assert.match(instructions, /Draft PR/u);
  assert.match(instructions, /Never push directly to `main`/u);
  assert.match(instructions, /Do not return or log tokens/u);
  assert.match(instructions, /User-facing text is Bulgarian/u);
  assert.doesNotMatch(instructions, /ghp_[A-Za-z0-9]+/u);
  assert.doesNotMatch(instructions, /sk-[A-Za-z0-9]+/u);
});
