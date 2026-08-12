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
    headers: {},
    append(name, value) {
      this.headers[name] ||= [];
      this.headers[name].push(value);
      return this;
    },
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

test("verified GitHub owner takes priority over a stale tester session", async () => {
  const middleware = createRequireOwnerSession({
    getSession: async (id) => {
      assert.equal(id, "owner-session");
      return {
        login: "radostinvgeorgiev-commits",
        accessToken: "protected-token",
      };
    },
    getUserSession: async () =>
      assert.fail("A verified owner session must bypass the tester session"),
  });
  const request = {
    headers: {
      cookie:
        "synchron_user_session=stale-tester; synchron_github_session=owner-session",
    },
  };
  const response = responseRecorder();
  let continued = false;

  await middleware(request, response, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.equal(request.owner.role, "owner");
  assert.equal(request.owner.authProvider, "github");
  assert.equal(request.owner.memoryOwnerId, "primary-user");
  assert.equal(response.headers["Set-Cookie"].length, 1);
  assert.match(response.headers["Set-Cookie"][0], /^synchron_user_session=;/u);
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
