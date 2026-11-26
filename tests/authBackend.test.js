import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthBackend } from "../src/config/authBackend.js";

test("Identity Platform is the only sign-in backend; the retired Supabase one is refused", () => {
  assert.equal(resolveAuthBackend({}), "identity-platform");
  assert.equal(
    resolveAuthBackend({ NODE_ENV: "production" }),
    "identity-platform",
  );
  assert.equal(
    resolveAuthBackend({ NODE_ENV: "production", AUTH_BACKEND: "supabase" }),
    null,
  );
  assert.equal(
    resolveAuthBackend({
      IDENTITY_PLATFORM_PROJECT_ID: "handy-boulevard-479120-q9",
    }),
    "identity-platform",
  );
});
