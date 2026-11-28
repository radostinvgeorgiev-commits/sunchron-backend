import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  afterSignInCookie,
  afterSignInPath,
  safeReturnPath,
  signInFirst,
} from "../src/middleware/signInFirst.js";
import { createGoogleSignInCallbackHandler } from "../src/routes/userAuthRouter.js";

function run(middleware, { url, host = "novariumai.com", method = "GET" }) {
  return new Promise((resolve) => {
    const headers = [];
    const req = { method, originalUrl: url, headers: {}, get: (name) => (name === "host" ? host : "") };
    const res = {
      append: (name, value) => headers.push([name, value]),
      redirect: (status, location) => resolve({ status, location, headers }),
    };
    middleware(req, res, () => resolve({ next: true, headers }));
  });
}

const env = { GOOGLE_REDIRECT_URI: "https://novariumai.com/api/google/callback" };

test("a connect link opened without a sign-in goes to the Google sign-in, not bare JSON", async () => {
  const middleware = signInFirst({ env, identify: async () => null });
  const result = await run(middleware, { url: "/api/google/connect?add=save" });
  assert.equal(result.status, 302);
  assert.equal(result.location, "/api/auth/google/start");
  assert.equal(afterSignInPath(result.headers[0][1].split(";")[0]), "/api/google/connect?add=save");
});

test("on the old name the link first moves to the public address", async () => {
  const middleware = signInFirst({ env, identify: async () => null });
  const result = await run(middleware, { url: "/api/google/connect?add=save", host: "cloudaicore.com" });
  assert.equal(result.location, "https://novariumai.com/api/google/connect?add=save");
  assert.deepEqual(result.headers, []);
});

test("signed in, or another path, goes on as before", async () => {
  const signedIn = signInFirst({ env, identify: async () => ({ id: "x" }) });
  assert.equal((await run(signedIn, { url: "/api/google/connect?add=save" })).next, true);
  const nobody = signInFirst({ env, identify: async () => null });
  assert.equal((await run(nobody, { url: "/api/google/status" })).next, true);
  assert.equal((await run(nobody, { url: "/api/google/connect?add=save", method: "POST" })).next, true);
});

test("only exact connect links can be a return path", () => {
  assert.equal(safeReturnPath("/api/google/connect"), "/api/google/connect");
  assert.equal(safeReturnPath("/api/google/connect?add=save"), "/api/google/connect?add=save");
  for (const bad of ["//evil.test", "https://evil.test/api/google/connect", "/api/google/connect?add=save&x=1", "/api/google/restore"]) {
    assert.equal(safeReturnPath(bad), "");
  }
  assert.equal(afterSignInPath(`a=1; ${afterSignInCookie("//evil.test").split(";")[0]}`), "");
});

test("after the Google sign-in the stored connect link continues", async () => {
  const keys = ["USER_SESSION_ENCRYPTION_KEY", "IDENTITY_PLATFORM_PROJECT_ID", "IDENTITY_PLATFORM_API_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.USER_SESSION_ENCRYPTION_KEY = "test-session-key-with-enough-entropy-123";
  process.env.IDENTITY_PLATFORM_PROJECT_ID = "test-identity-project";
  process.env.IDENTITY_PLATFORM_API_KEY = "test-identity-platform-api-key-123";
  try {
  const handler = createGoogleSignInCallbackHandler({
    finish: async () => ({ user: { id: "u" }, session: { access_token: "a", refresh_token: "r", expires_at: 9_999_999_999 } }),
    getSession: async () => null,
    linkOwner: async () => {},
    logError: () => {},
  });
  const answer = (cookie) =>
    new Promise((resolve) => {
      let cookies = [];
      handler(
        { query: { code: "c", state: "st" }, headers: { cookie } },
        {
          setHeader: (_name, value) => (cookies = value),
          redirect: (status, location) => resolve({ status, location, cookies }),
        },
      );
    });
  const back = await answer(afterSignInCookie("/api/google/connect?add=save").split(";")[0]);
  assert.equal(back.location, "/api/google/connect?add=save");
  assert.ok(back.cookies.some((value) => value.startsWith("novarium_after_signin=;")));
  assert.equal((await answer("")).location, "/");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a sign-in that cannot be renewed just now says so on a page with the same link", async () => {
  const passingFault = () =>
    Object.assign(new Error("Входът временно не е достъпен. Опитай отново след малко."), {
      status: 503,
      code: "AUTH_UNAVAILABLE",
    });
  const app = express();
  app.get("/api/google/connect", signInFirst({ env, identify: async () => { throw passingFault(); } }), (_req, res) =>
    res.json({ connect: true }),
  );
  const shown = await request(app).get("/api/google/connect?add=save").expect(503);
  assert.match(shown.headers["content-type"], /^text\/html/u);
  assert.equal(shown.headers["cache-control"], "no-store");
  assert.equal(shown.headers["retry-after"], "5");
  assert.equal(shown.headers["set-cookie"], undefined, "no return cookie, the sign-in is kept");
  assert.match(shown.text, /Входът временно не е достъпен/u);
  assert.match(shown.text, /Входът ти е запазен/u);
  assert.match(shown.text, /<a href="\/api\/google\/connect\?add=save">Опитай пак<\/a>/u);
  assert.doesNotMatch(shown.text, /AUTH_UNAVAILABLE|"error"/u);

  // Any other fault goes on to the route as before.
  const other = express();
  other.get("/api/google/connect", signInFirst({ env, identify: async () => { throw new Error("boom"); } }), (_req, res) =>
    res.json({ connect: true }),
  );
  assert.deepEqual((await request(other).get("/api/google/connect").expect(200)).body, { connect: true });
});
