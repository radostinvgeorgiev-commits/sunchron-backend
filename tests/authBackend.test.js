import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthBackend } from "../src/config/authBackend.js";

test("auth defaults to Identity Platform in production and keeps explicit legacy override", () => {
  assert.equal(resolveAuthBackend({}), "supabase");
  assert.equal(
    resolveAuthBackend({ NODE_ENV: "production" }),
    "identity-platform",
  );
  assert.equal(
    resolveAuthBackend({ NODE_ENV: "production", AUTH_BACKEND: "supabase" }),
    "supabase",
  );
  assert.equal(
    resolveAuthBackend({
      IDENTITY_PLATFORM_PROJECT_ID: "handy-boulevard-479120-q9",
    }),
    "identity-platform",
  );
});
