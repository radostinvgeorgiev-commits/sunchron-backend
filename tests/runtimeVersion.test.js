import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeVersion } from "../src/config/runtimeVersion.js";

test("runtime version prefers an explicit deployed commit", () => {
  assert.deepEqual(
    resolveRuntimeVersion({
      npm_package_version: "2.0.0",
      APP_COMMIT_SHA: "abc1234",
    }),
    { version: "2.0.0", commit: "abc1234" },
  );
});

test("runtime version always returns a safe commit string", () => {
  const result = resolveRuntimeVersion({});
  assert.equal(typeof result.commit, "string");
  assert.ok(result.commit.length > 0);
});
