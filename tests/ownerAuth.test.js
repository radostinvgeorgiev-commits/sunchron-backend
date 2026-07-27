import assert from "node:assert/strict";
import test from "node:test";

import { createRequireOwnerSession } from "../src/middleware/ownerAuth.js";

process.env.GITHUB_REPOSITORY =
  "radostinvgeorgiev-commits/sunchron-backend";

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
  });
  assert.equal(response.payload, null);
});
