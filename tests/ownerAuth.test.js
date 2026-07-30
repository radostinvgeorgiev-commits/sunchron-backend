import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequireOwnerSession,
  requirePrimaryOwner,
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
  assert.equal(response.payload.code, "AUTH_REQUIRED");
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
  assert.equal(response.payload.code, "AUTH_REQUIRED");
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
    displayName: "Радко",
    role: "owner",
    authProvider: "github",
    memoryOwnerId: "primary-user",
  });
  assert.equal(response.payload, null);
});

test("allows a Supabase tester with a separate memory namespace", async () => {
  const middleware = createRequireOwnerSession({
    getUserSession: async () => ({
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "friend@example.com",
        displayName: "Приятел",
        role: "tester",
        memoryOwnerId: "supabase:11111111-1111-4111-8111-111111111111",
      },
      refreshed: false,
    }),
    getSession: async () =>
      assert.fail("GitHub fallback must not run for a valid user session"),
  });
  const request = { headers: {} };
  const response = responseRecorder();
  let continued = false;

  await middleware(request, response, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.deepEqual(request.owner, {
    id: "11111111-1111-4111-8111-111111111111",
    email: "friend@example.com",
    displayName: "Приятел",
    role: "tester",
    authProvider: "supabase",
    memoryOwnerId: "supabase:11111111-1111-4111-8111-111111111111",
  });
});

test("owner-only middleware blocks testers and allows the owner", () => {
  const testerResponse = responseRecorder();
  requirePrimaryOwner({ owner: { role: "tester" } }, testerResponse, () =>
    assert.fail("Tester must not pass the owner boundary"),
  );
  assert.equal(testerResponse.statusCode, 403);
  assert.equal(testerResponse.payload.code, "OWNER_ONLY");

  let ownerContinued = false;
  requirePrimaryOwner({ owner: { role: "owner" } }, responseRecorder(), () => {
    ownerContinued = true;
  });
  assert.equal(ownerContinued, true);
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
