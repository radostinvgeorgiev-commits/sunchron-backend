import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequireOwnerSession,
  resolveMemoryOwnerId,
} from "../src/middleware/ownerAuth.js";

process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

test("rejects a request without a server-side owner session", async () => {
  const middleware = createRequireOwnerSession({
    getSession: async () => null,
  });
  const response = responseRecorder();
  let continued = false;

  await middleware({ headers: {} }, response, () => {
    continued = true;
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.code, "OWNER_AUTH_REQUIRED");
});

test("rejects a session belonging to another GitHub profile", async () => {
  const middleware = createRequireOwnerSession({
    getSession: async () => ({
      login: "another-user",
      accessToken: "protected-token",
    }),
  });
  const response = responseRecorder();

  await middleware(
    {
      headers: { cookie: "synchron_github_session=session-123" },
    },
    response,
    () => assert.fail("Unauthorized request must not continue"),
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.payload.code, "OWNER_AUTH_REQUIRED");
  assert.doesNotMatch(JSON.stringify(response.payload), /protected-token/u);
});

test("allows only the configured owner and attaches verified identity", async () => {
  const middleware = createRequireOwnerSession({
    getSession: async (id) => {
      assert.equal(id, "session-123");
      return {
        login: "radostinvgeorgiev-commits",
        accessToken: "protected-token",
      };
    },
  });
  const request = {
    headers: { cookie: "synchron_github_session=session-123" },
  };
  const response = responseRecorder();
  let continued = false;

  await middleware(request, response, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.deepEqual(request.owner, {
    id: "radostinvgeorgiev-commits",
    login: "radostinvgeorgiev-commits",
    memoryOwnerId: "primary-user",
  });
  assert.equal(response.payload, null);
});

test("memory owner id is stable before and after a new OAuth callback", () => {
  const env = {
    GITHUB_REPOSITORY: "radostinvgeorgiev-commits/sunchron-backend",
    MEMORY_OWNER_ID: "primary-user",
  };

  const firstSessionOwner = resolveMemoryOwnerId(
    "RadostinVGeorgiev-Commits",
    env,
  );
  const refreshedSessionOwner = resolveMemoryOwnerId(
    "radostinvgeorgiev-commits",
    env,
  );

  assert.equal(firstSessionOwner, "primary-user");
  assert.equal(refreshedSessionOwner, firstSessionOwner);
});

test("different GitHub users receive different memory namespaces", () => {
  const env = {
    GITHUB_REPOSITORY: "owner/sunchron-backend",
    MEMORY_OWNER_ID: "legacy-owner",
  };

  assert.equal(resolveMemoryOwnerId("owner", env), "legacy-owner");
  assert.equal(
    resolveMemoryOwnerId("another-user", env),
    "github:another-user",
  );
  assert.notEqual(
    resolveMemoryOwnerId("owner", env),
    resolveMemoryOwnerId("another-user", env),
  );
});
