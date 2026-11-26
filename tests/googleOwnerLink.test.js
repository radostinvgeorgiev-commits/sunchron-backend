import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleSignInCallbackHandler } from "../src/routes/userAuthRouter.js";

process.env.GITHUB_REPOSITORY = "radostinvgeorgiev-commits/sunchron-backend";
process.env.USER_SESSION_ENCRYPTION_KEY ||= "test-session-key-with-enough-entropy-123";

function recorder() {
  return {
    headers: {},
    location: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    redirect(status, location) {
      this.status = status;
      this.location = location;
      return this;
    },
  };
}

const googleUser = { id: "google-owner", authProvider: "identity-platform" };
const finish = async () => ({
  user: googleUser,
  session: { access_token: "a", refresh_token: "r", expires_at: 9_999_999_999 },
});

test("Google sign-in next to the owner GitHub session links the account", async () => {
  const linked = [];
  const handler = createGoogleSignInCallbackHandler({
    finish,
    getSession: async (id) => {
      assert.equal(id, "owner-session");
      return { login: "radostinvgeorgiev-commits" };
    },
    linkOwner: async (user) => linked.push(user),
  });
  const res = recorder();
  await handler(
    { query: { code: "c", state: "s" }, headers: { cookie: "synchron_github_session=owner-session" } },
    res,
  );
  assert.deepEqual(linked, [googleUser]);
  assert.equal(res.location, "/?owner_google_linked=1");
});

test("Google sign-in without the owner session never links", async () => {
  const handler = createGoogleSignInCallbackHandler({
    finish,
    getSession: async () => ({ login: "someone-else" }),
    linkOwner: async () => assert.fail("must not link"),
  });
  const res = recorder();
  await handler(
    { query: { code: "c", state: "s" }, headers: { cookie: "synchron_github_session=other" } },
    res,
  );
  assert.equal(res.location, "/");
  assert.ok(Array.isArray(res.headers["Set-Cookie"]));
});

test("a failed link still signs the person in as before", async () => {
  const handler = createGoogleSignInCallbackHandler({
    finish,
    getSession: async () => ({ login: "radostinvgeorgiev-commits" }),
    linkOwner: async () => {
      throw new Error("storage down");
    },
    logError: () => {},
  });
  const res = recorder();
  await handler(
    { query: { code: "c", state: "s" }, headers: { cookie: "synchron_github_session=owner" } },
    res,
  );
  assert.equal(res.location, "/");
});
