import assert from "node:assert/strict";
import test from "node:test";

import { callbackForStart, startOnCallbackOrigin } from "../src/middleware/startOnCallbackOrigin.js";

// One request through the middleware: the redirect it answers with, "next"
// when it lets the request through, or "nothing" when it does neither.
const run = (env, { method = "GET", host, url, path = url.replace(/\?.*$/u, "") }) => {
  let redirect = null;
  let passed = false;
  const headers = {};
  startOnCallbackOrigin(env)(
    { method, path, originalUrl: url, get: (name) => (name.toLowerCase() === "host" ? host : undefined) },
    {
      set: (name, value) => (headers[name.toLowerCase()] = value),
      redirect: (status, to) => (redirect = [status, to, headers["cache-control"]]),
    },
    () => (passed = true),
  );
  return redirect || (passed ? "next" : "nothing");
};
const moved = (to) => [302, to, "no-store"];

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
];

test("today Google and GitHub return to the old name: a sign-in on novariumai.com moves there first", () => {
  const today = returnsTo(OLD, OLD);
  for (const url of STARTS) {
    assert.deepEqual(run(today, { host: "novariumai.com", url }), moved(`${OLD}${url}?moved=1`), url);
    assert.deepEqual(run(today, { host: "www.novariumai.com", url }), moved(`${OLD}${url}?moved=1`), url);
    assert.equal(run(today, { host: "cloudaicore.com", url }), "next", url);
  }
  // Its own query stays, and moved=1 is set once.
  assert.deepEqual(
    run(today, { host: "novariumai.com", url: "/api/auth/google/start?x=1&moved=0" }),
    moved(`${OLD}/api/auth/google/start?x=1&moved=1`),
  );
});

test("after the move the old name sends every sign-in to novariumai.com", () => {
  const after = returnsTo(NEW, NEW);
  for (const url of STARTS) {
    assert.deepEqual(run(after, { host: "cloudaicore.com", url }), moved(`${NEW}${url}?moved=1`), url);
    assert.deepEqual(run(after, { host: "www.cloudaicore.com", url }), moved(`${NEW}${url}?moved=1`), url);
    assert.deepEqual(run(after, { host: "www.novariumai.com", url }), moved(`${NEW}${url}?moved=1`), url);
    assert.equal(run(after, { host: "novariumai.com", url }), "next", url);
  }
});

test("each provider follows its own return address, also while only one has moved", () => {
  const googleMoved = returnsTo(NEW, OLD);
  assert.deepEqual(
    run(googleMoved, { host: "cloudaicore.com", url: "/api/auth/google/start" }),
    moved(`${NEW}/api/auth/google/start?moved=1`),
  );
  assert.equal(run(googleMoved, { host: "cloudaicore.com", url: "/api/auth/github/start" }), "next");
  assert.deepEqual(
    run(googleMoved, { host: "novariumai.com", url: "/api/auth/github/start" }),
    moved(`${OLD}/api/auth/github/start?moved=1`),
  );
  // Facebook and Microsoft come back to the public address, which follows Google.
  assert.equal(callbackForStart("/api/auth/facebook/start", googleMoved), `${NEW}/api/auth/facebook/callback`);
  // Without GITHUB_REDIRECT_URI GitHub returns to novariumai.com (its default).
  assert.equal(callbackForStart("/api/auth/github/start", {}), `${NEW}/api/github/callback`);
  assert.deepEqual(
    run({ GOOGLE_REDIRECT_URI: `${OLD}/api/google/callback` }, { host: "cloudaicore.com", url: "/api/auth/github/start" }),
    moved(`${NEW}/api/auth/github/start?moved=1`),
  );
});

test("routes match without regard to case and with one trailing slash, and so does the move", () => {
  const today = returnsTo(OLD, OLD);
  assert.deepEqual(
    run(today, { host: "novariumai.com", url: "/api/auth/google/start/" }),
    moved(`${OLD}/api/auth/google/start/?moved=1`),
  );
  assert.deepEqual(
    run(today, { host: "NovariumAI.com", url: "/API/Auth/Google/Start" }),
    moved(`${OLD}/API/Auth/Google/Start?moved=1`),
  );
  // Express does not route two trailing slashes to the start, so neither do we.
  assert.equal(run(today, { host: "novariumai.com", url: "/api/auth/google/start//" }), "next");
});

test("connecting Google or GitHub never moves: it belongs to the account signed in where it was pressed", () => {
  for (const env of [returnsTo(OLD, OLD), returnsTo(NEW, NEW)]) {
    for (const host of ["cloudaicore.com", "novariumai.com", "www.cloudaicore.com", "www.novariumai.com"]) {
      for (const url of ["/api/google/connect", "/api/google/connect?add=gmail", "/api/github/connect"]) {
        assert.equal(run(env, { host, url }), "next", `${host}${url}`);
      }
    }
  }
});

test("the address it sends to always stays on the site's own names over https", () => {
  const today = returnsTo(OLD, OLD);
  // An absolute or "//" request target is never glued to the address.
  for (const url of [
    "munity://evil.test/api/auth/google/start",
    "https://evil.test/api/auth/google/start",
    "//evil.test/api/auth/google/start",
  ]) {
    assert.equal(run(today, { host: "novariumai.com", url, path: "/api/auth/google/start" }), "next", url);
  }
  // A return address outside the site's names, or over http, is never followed.
  assert.equal(
    run(returnsTo("https://example.test", "https://example.test"), { host: "novariumai.com", url: "/api/auth/google/start" }),
    "next",
  );
  assert.equal(run(returnsTo("http://cloudaicore.com", "http://cloudaicore.com"), { host: "novariumai.com", url: "/api/auth/github/start" }), "next");
});

test("only sign-in starts, only GET, only the site's own names move", () => {
  const after = returnsTo(NEW, NEW);
  for (const url of [
    "/api/google/callback?code=x&state=y",
    "/api/auth/google/callback?code=x",
    "/api/github/callback?code=x",
    "/api/auth/facebook/callback",
    "/api/auth/apple/start",
    "/api/auth/__proto__/start",
    "/api/auth/google/start/extra",
    "/mcp",
    "/oauth/authorize?client_id=x",
    "/",
  ]) {
    assert.equal(run(after, { host: "cloudaicore.com", url }), "next", url);
  }
  for (const method of ["POST", "HEAD", "OPTIONS"]) {
    assert.equal(run(after, { method, host: "cloudaicore.com", url: "/api/auth/google/start" }), "next", method);
  }
  for (const host of ["127.0.0.1:8080", "localhost:3000", "synchron-backend-google-abc.a.run.app", "novariumai.com.", "", undefined]) {
    assert.equal(run(after, { host, url: "/api/auth/google/start" }), "next", String(host));
  }
});
