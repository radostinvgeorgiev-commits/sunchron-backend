import assert from "node:assert/strict";
import test from "node:test";

// „Свържи Google“ pressed on one of the site's names, while Google comes back
// to the other one (RADKO, 28.11.2026 05:45 UTC: INVALID_OAUTH_STATE). The
// connect runs through the real router, its state cookie and callback, in a
// browser that keeps cookies per name (host-only, as on the live site). Only
// Google's token swap is stubbed.
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI = "https://cloudaicore.com/api/google/callback";
process.env.GITHUB_CLIENT_ID = "test-github-client";
process.env.GITHUB_CLIENT_SECRET = "test-github-secret";
process.env.GITHUB_REDIRECT_URI = "https://cloudaicore.com/api/github/callback";
process.env.USER_SESSION_ENCRYPTION_KEY ||= "test-session-key-with-enough-entropy-123";
delete process.env.PUBLIC_ORIGIN;

const { default: express } = await import("express");
const { default: request } = await import("supertest");
const { markStartHost, returnToConnectStart, startHostOf } = await import(
  "../src/middleware/returnToConnectStart.js"
);
const { default: googleDriveRouter } = await import("../src/routes/googleDriveRouter.js");
const { resetGoogleSessionsForTests } = await import("../src/services/googleDriveService.js");

const OLD = "cloudaicore.com";
const NEW = "novariumai.com";
const SITE = new Set([OLD, `www.${OLD}`, NEW, `www.${NEW}`]);

test("the state says on which of the site's names a connect started", () => {
  assert.equal(markStartHost("abc", NEW), "abc.at-n");
  assert.equal(markStartHost("abc", `www.${NEW}`), "abc.at-wn");
  assert.equal(markStartHost("save.abc", OLD), "save.abc.at-c");
  assert.equal(markStartHost("abc", `WWW.${OLD.toUpperCase()}`), "abc.at-wc");
  for (const host of ["127.0.0.1:3000", "synchron-backend-google-abc.a.run.app", `${NEW}.`, "evil.test", "", undefined]) {
    assert.equal(markStartHost("abc", host), "abc", String(host));
  }
  assert.equal(startHostOf("abc.at-n"), NEW);
  assert.equal(startHostOf("save.abc.at-wc"), `www.${OLD}`);
  for (const state of ["abc", "abc.at-x", "abc.at-n.more", "at-n", "", undefined]) {
    assert.equal(startHostOf(state), "", String(state));
  }
});

// One request through the step: the redirect it answers with, or "next".
const run = ({ method = "GET", host, url, cookie = "" }) => {
  let redirect = null;
  const headers = {};
  // As Express reads it: a repeated name becomes a list.
  const query = {};
  for (const [key, value] of new URL(url, "https://x.test").searchParams) {
    query[key] = Object.hasOwn(query, key) ? [].concat(query[key], value) : value;
  }
  returnToConnectStart({ path: "/api/google/callback", cookie: "synchron_google_state" })(
    {
      method,
      query,
      originalUrl: url,
      headers: { cookie },
      get: (name) => (name.toLowerCase() === "host" ? host : undefined),
    },
    {
      set: (name, value) => (headers[name.toLowerCase()] = value),
      redirect: (status, to) =>
        (redirect = [status, to, headers["cache-control"], headers["referrer-policy"]]),
    },
    () => (redirect = "next"),
  );
  return redirect;
};
const sent = (to) => [302, to, "no-store", "no-referrer"];

test("a return to the other name goes once to the name where the connect started", () => {
  const url = "/api/google/callback?code=c&state=abc.at-n&scope=x";
  assert.deepEqual(run({ host: OLD, url }), sent(`https://${NEW}${url}`));
  assert.deepEqual(run({ host: `www.${OLD}`, url }), sent(`https://${NEW}${url}`));
  // Google's „Отказ“ comes back without a code: also to where it started.
  assert.deepEqual(
    run({ host: OLD, url: "/api/google/callback?error=access_denied&state=abc.at-wn" }),
    sent(`https://www.${NEW}/api/google/callback?error=access_denied&state=abc.at-wn`),
  );
  // After the return addresses move, the other way round.
  assert.deepEqual(
    run({ host: NEW, url: "/api/google/callback?code=c&state=save.abc.at-c" }),
    sent(`https://${OLD}/api/google/callback?code=c&state=save.abc.at-c`),
  );
});

test("everything else is left to the callback as before", () => {
  // This name's own cookie holds the state: the normal check.
  assert.equal(
    run({ host: OLD, url: "/api/google/callback?code=c&state=abc.at-n", cookie: "a=1; synchron_google_state=abc.at-n" }),
    "next",
  );
  // Already on the name it started on: no second hop, the check answers.
  assert.equal(run({ host: NEW, url: "/api/google/callback?code=c&state=abc.at-n" }), "next");
  // A state without a mark: a sign-in, or a connect from before this change.
  assert.equal(run({ host: OLD, url: "/api/google/callback?code=c&state=abc" }), "next");
  assert.equal(run({ host: OLD, url: "/api/google/callback?code=c" }), "next");
  assert.equal(run({ host: OLD, url: "/api/google/callback?code=c&state=a.at-n&state=b.at-n" }), "next");
  // Only GET, only the site's own names.
  for (const method of ["POST", "HEAD", "OPTIONS"]) {
    assert.equal(run({ method, host: OLD, url: "/api/google/callback?state=abc.at-n" }), "next", method);
  }
  for (const host of ["127.0.0.1:8080", "synchron-backend-google-abc.a.run.app", `${OLD}.`, "evil.test", ""]) {
    assert.equal(run({ host, url: "/api/google/callback?state=abc.at-n" }), "next", host);
  }
});

test("the address it sends to stays on the start name and the callback's own path", () => {
  for (const url of [
    "/api/google/callback?state=abc.at-n&next=//evil.test/x",
    "/api/google/callback?state=abc.at-n&x=https://evil.test",
    "/api/google/callback?state=abc.at-n#//evil.test",
  ]) {
    const answer = run({ host: OLD, url });
    assert.equal(answer[0], 302, url);
    const location = new URL(answer[1]);
    assert.equal(location.origin, `https://${NEW}`, url);
    assert.equal(location.pathname, "/api/google/callback", url);
  }
});

// ── Through the real router, in a browser ─────────────────────────────────

function cookieJar() {
  const jar = new Map();
  return {
    set(host, header) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const [name, ...rest] = pair.split("=");
      const path = attributes.find((part) => /^path=/iu.test(part))?.slice(5) || "/";
      const maxAge = attributes.find((part) => /^max-age=/iu.test(part))?.slice(8);
      const kept = (jar.get(host) || []).filter((cookie) => !(cookie.name === name && cookie.path === path));
      if (maxAge !== "0") kept.push({ name, value: rest.join("="), path });
      jar.set(host, kept);
    },
    header(host, path) {
      return (jar.get(host) || [])
        .filter((cookie) => path === cookie.path || path.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    },
    names(host) {
      return (jar.get(host) || []).map((cookie) => cookie.name);
    },
  };
}

async function follow(app, jar, address) {
  let url = new URL(address);
  const statuses = [];
  for (let step = 0; step < 6; step += 1) {
    // The page the person ends on is not fetched: only the site's /api steps.
    if (!SITE.has(url.host) || !url.pathname.startsWith("/api/")) return { url, statuses };
    const response = await request(app)
      .get(`${url.pathname}${url.search}`)
      .set("Host", url.host)
      .set("Cookie", jar.header(url.host, url.pathname));
    statuses.push(`${url.host} ${response.status}`);
    for (const cookie of [].concat(response.headers["set-cookie"] || [])) jar.set(url.host, cookie);
    if (response.status < 300 || response.status >= 400) return { url, statuses };
    url = new URL(response.headers.location, url);
  }
  return { url, statuses };
}

const owner = { memoryOwnerId: "owner:radko", role: "owner" };
const MAIN =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/contacts";
const idToken = (sub) => ["h", Buffer.from(JSON.stringify({ sub })).toString("base64url"), "s"].join(".");

// The routes in server.js's order: the step before the session check. The
// person is signed in only on the names in `signedIn`.
function site({ withStep = true, signedIn }) {
  const app = express();
  if (withStep) {
    app.get("/api/google/callback", returnToConnectStart({ path: "/api/google/callback", cookie: "synchron_google_state" }));
  }
  app.use(
    "/api/google",
    (req, res, next) => {
      if (!signedIn.includes(req.get("host"))) return res.status(401).json({ code: "AUTH_REQUIRED" });
      req.owner = owner;
      return next();
    },
    googleDriveRouter,
  );
  return app;
}

async function withGoogleTokens(callback) {
  const realFetch = globalThis.fetch;
  const swaps = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://oauth2.googleapis.com/token") throw new Error(`no network in tests: ${url}`);
    swaps.push(new URLSearchParams(String(init?.body || "")).get("redirect_uri"));
    return new Response(
      JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: MAIN, id_token: idToken("google-1") }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    return await callback(swaps);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Press „Свържи Google“ on one name, allow at Google, come back.
async function connect({ app, pressedOn, state: forcedState }) {
  const jar = cookieJar();
  const pressed = await follow(app, jar, `https://${pressedOn}/api/google/connect?add=gmail`);
  assert.equal(pressed.url.host, "accounts.google.com");
  const back = new URL(pressed.url.searchParams.get("redirect_uri"));
  back.search = new URLSearchParams({ code: "c", state: forcedState || pressed.url.searchParams.get("state") }).toString();
  const end = await follow(app, jar, back.href);
  return { state: pressed.url.searchParams.get("state"), end: end.url.href, statuses: end.statuses, jar };
}

test("„Свържи Google“ pressed on novariumai.com fails without the step and works with it", async () => {
  await withGoogleTokens(async (swaps) => {
    resetGoogleSessionsForTests();
    const before = await connect({ app: site({ withStep: false, signedIn: [NEW] }), pressedOn: NEW });
    assert.deepEqual(before.statuses, [`${OLD} 401`]);
    assert.deepEqual(swaps, []);

    // Signed in on both names, as RADKO was: the other name's check fails.
    const both = await connect({ app: site({ withStep: false, signedIn: [NEW, OLD] }), pressedOn: NEW });
    assert.equal(both.end, `https://${OLD}/?google=error`);

    const after = await connect({ app: site({ signedIn: [NEW] }), pressedOn: NEW });
    assert.match(after.state, /\.at-n$/u);
    assert.deepEqual(after.statuses, [`${OLD} 302`, `${NEW} 302`]);
    assert.equal(after.end, `https://${NEW}/?google=connected`);
    assert.ok(after.jar.names(NEW).includes("synchron_google_session"), after.jar.names(NEW).join(","));
    assert.deepEqual(after.jar.names(OLD), []);
    // The token swap keeps the return address Google was given.
    assert.deepEqual(swaps, [`https://${OLD}/api/google/callback`]);
    resetGoogleSessionsForTests();
  });
});

test("a connect pressed on the name Google returns to works as before", async () => {
  await withGoogleTokens(async () => {
    resetGoogleSessionsForTests();
    const same = await connect({ app: site({ signedIn: [OLD] }), pressedOn: OLD });
    assert.match(same.state, /\.at-c$/u);
    assert.deepEqual(same.statuses, [`${OLD} 302`]);
    assert.equal(same.end, `https://${OLD}/?google=connected`);
    resetGoogleSessionsForTests();
  });
});

test("a return with someone else's state is still refused where it lands", async () => {
  await withGoogleTokens(async (swaps) => {
    resetGoogleSessionsForTests();
    // A link with another browser's state („…at-n“) is sent on, and the
    // state check on novariumai.com refuses it: nothing is connected.
    const other = await connect({ app: site({ signedIn: [NEW, OLD] }), pressedOn: NEW, state: "someone-else.at-n" });
    assert.equal(other.end, `https://${NEW}/?google=error`);
    assert.deepEqual(swaps, []);
    resetGoogleSessionsForTests();
  });
});

// ── In the real app ────────────────────────────────────────────────────────

test("in the real app the step comes before the session check, for Google and GitHub", async () => {
  const { default: app } = await import("../server.js");
  const google = await request(app).get("/api/google/callback?code=c&state=abc.at-n").set("Host", OLD);
  assert.equal(google.status, 302);
  assert.equal(google.headers.location, `https://${NEW}/api/google/callback?code=c&state=abc.at-n`);
  assert.equal(google.headers["cache-control"], "no-store");
  assert.equal(google.headers["referrer-policy"], "no-referrer");
  assert.equal(google.headers["set-cookie"], undefined);
  // On the name it started on, the session check answers as before.
  const there = await request(app).get("/api/google/callback?code=c&state=abc.at-n").set("Host", NEW);
  assert.equal(there.status, 401);

  const github = await request(app).get("/api/github/callback?code=c&state=abc.at-n").set("Host", OLD);
  assert.equal(github.status, 302);
  assert.equal(github.headers.location, `https://${NEW}/api/github/callback?code=c&state=abc.at-n`);

  // „Свържи GitHub“ marks where it was pressed; GitHub gets the same return address.
  const pressed = await request(app).get("/api/github/connect").set("Host", NEW);
  assert.equal(pressed.status, 302);
  const at = new URL(pressed.headers.location);
  assert.equal(at.host, "github.com");
  assert.match(at.searchParams.get("state"), /\.at-n$/u);
  assert.equal(at.searchParams.get("redirect_uri"), `https://${OLD}/api/github/callback`);
  assert.ok(
    [].concat(pressed.headers["set-cookie"]).some((cookie) => cookie.startsWith(`synchron_github_state=${at.searchParams.get("state")};`)),
  );
  // Without a site name (a test server, the Cloud Run address) nothing changes.
  const plain = await request(app).get("/api/github/connect").set("Host", "127.0.0.1:3000");
  assert.doesNotMatch(new URL(plain.headers.location).searchParams.get("state"), /\.at-/u);
});
