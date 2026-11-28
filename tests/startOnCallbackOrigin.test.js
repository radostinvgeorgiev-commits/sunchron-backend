import assert from "node:assert/strict";
import test from "node:test";

import { callbackForStart, startOnCallbackOrigin } from "../src/middleware/startOnCallbackOrigin.js";

// One request through the middleware: the redirect it answers with, "next"
// when it lets the request through, or "nothing" when it does neither.
const run = (env, { method = "GET", host, url }) => {
  const path = url.replace(/\?.*$/u, "");
  let redirect = null;
  let passed = false;
  startOnCallbackOrigin(env)(
    { method, path, originalUrl: url, get: (name) => (name.toLowerCase() === "host" ? host : undefined) },
    { redirect: (status, to) => (redirect = [status, to]) },
    () => (passed = true),
  );
  return redirect || (passed ? "next" : "nothing");
};

const OLD = "https://cloudaicore.com";
const NEW = "https://novariumai.com";
const returnsTo = (google, github) => ({
  GOOGLE_REDIRECT_URI: `${google}/api/google/callback`,
  GITHUB_REDIRECT_URI: `${github}/api/github/callback`,
});
const STARTS = [
  "/api/auth/google/start",
  "/api/auth/github/start",
  "/api/auth/facebook/start",
  "/api/auth/microsoft/start",
  "/api/google/connect?add=gmail",
  "/api/github/connect",
];

test("today Google and GitHub return to the old name: a start on novariumai.com moves there first", () => {
  const today = returnsTo(OLD, OLD);
  for (const url of STARTS) {
    assert.deepEqual(run(today, { host: "novariumai.com", url }), [302, `${OLD}${url}`], url);
    assert.deepEqual(run(today, { host: "www.novariumai.com", url }), [302, `${OLD}${url}`], url);
    assert.equal(run(today, { host: "cloudaicore.com", url }), "next", url);
  }
});

test("after the move the old name sends every start to novariumai.com", () => {
  const moved = returnsTo(NEW, NEW);
  for (const url of STARTS) {
    assert.deepEqual(run(moved, { host: "cloudaicore.com", url }), [302, `${NEW}${url}`], url);
    assert.deepEqual(run(moved, { host: "www.cloudaicore.com", url }), [302, `${NEW}${url}`], url);
    assert.deepEqual(run(moved, { host: "www.novariumai.com", url }), [302, `${NEW}${url}`], url);
    assert.equal(run(moved, { host: "novariumai.com", url }), "next", url);
  }
});

test("each provider follows its own return address, also while only one has moved", () => {
  const googleMoved = returnsTo(NEW, OLD);
  // Google's starts go to novariumai.com, GitHub's stay with GitHub's old name.
  assert.deepEqual(run(googleMoved, { host: "cloudaicore.com", url: "/api/auth/google/start" }), [
    302,
    `${NEW}/api/auth/google/start`,
  ]);
  assert.deepEqual(run(googleMoved, { host: "cloudaicore.com", url: "/api/google/connect?add=drive" }), [
    302,
    `${NEW}/api/google/connect?add=drive`,
  ]);
  assert.equal(run(googleMoved, { host: "cloudaicore.com", url: "/api/auth/github/start" }), "next");
  assert.equal(run(googleMoved, { host: "cloudaicore.com", url: "/api/github/connect" }), "next");
  assert.deepEqual(run(googleMoved, { host: "novariumai.com", url: "/api/auth/github/start" }), [
    302,
    `${OLD}/api/auth/github/start`,
  ]);
  // Facebook and Microsoft come back to the public address, which follows Google.
  assert.equal(callbackForStart("/api/auth/facebook/start", googleMoved), `${NEW}/api/auth/facebook/callback`);
  // Without GITHUB_REDIRECT_URI GitHub returns to novariumai.com (its default).
  assert.equal(callbackForStart("/api/github/connect", {}), `${NEW}/api/github/callback`);
  assert.deepEqual(run({ GOOGLE_REDIRECT_URI: `${OLD}/api/google/callback` }, { host: "cloudaicore.com", url: "/api/auth/github/start" }), [
    302,
    `${NEW}/api/auth/github/start`,
  ]);
});

test("routes match without regard to case or a trailing slash, and so does the move", () => {
  const today = returnsTo(OLD, OLD);
  assert.deepEqual(run(today, { host: "novariumai.com", url: "/api/auth/google/start/" }), [
    302,
    `${OLD}/api/auth/google/start/`,
  ]);
  assert.deepEqual(run(today, { host: "NovariumAI.com", url: "/API/Google/Connect?add=gmail" }), [
    302,
    `${OLD}/API/Google/Connect?add=gmail`,
  ]);
});

test("only start addresses, only GET, only the site's own names move", () => {
  const moved = returnsTo(NEW, NEW);
  for (const url of [
    "/api/google/callback?code=x&state=y",
    "/api/auth/google/callback?code=x",
    "/api/github/callback?code=x",
    "/api/auth/facebook/callback",
    "/api/auth/apple/start",
    "/api/auth/google/start/extra",
    "/mcp",
    "/oauth/authorize?client_id=x",
    "/",
  ]) {
    assert.equal(run(moved, { host: "cloudaicore.com", url }), "next", url);
  }
  assert.equal(run(moved, { method: "POST", host: "cloudaicore.com", url: "/api/auth/google/start" }), "next");
  assert.equal(run(moved, { method: "HEAD", host: "cloudaicore.com", url: "/api/auth/google/start" }), "next");
  for (const host of ["127.0.0.1:8080", "localhost:3000", "synchron-backend-google-abc.a.run.app", "", undefined]) {
    assert.equal(run(moved, { host, url: "/api/auth/google/start" }), "next", String(host));
  }
  // A return address outside the site's names is never followed.
  assert.equal(
    run(returnsTo("https://example.test", "https://example.test"), { host: "novariumai.com", url: "/api/auth/google/start" }),
    "next",
  );
  // Google connect without a return address is not configured; nothing moves.
  assert.equal(run({}, { host: "cloudaicore.com", url: "/api/google/connect" }), "next");
});
