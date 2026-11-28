import assert from "node:assert/strict";
import test from "node:test";

// A sign-in through the real start handler, state cookie and callback, in a
// browser that keeps cookies per name (host-only, as on the live site). Only
// the network parts (Google's token swap, Identity Platform, the owner link
// store, the GitHub session lookup) are stubbed.
process.env.NODE_ENV = "test";
process.env.USER_REGISTRATION_MODE = "public";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.SYNCHRON_OWNER_GITHUB_LOGIN = "owner-login";
process.env.USER_SESSION_ENCRYPTION_KEY ||= "test-session-key-with-enough-entropy-123";
process.env.IDENTITY_PLATFORM_PROJECT_ID ||= "test-identity-project";
process.env.IDENTITY_PLATFORM_API_KEY ||= "test-identity-platform-api-key-123";
delete process.env.GOOGLE_SIGN_IN;
delete process.env.PUBLIC_ORIGIN;

const { default: express } = await import("express");
const { default: request } = await import("supertest");
const { startOnCallbackOrigin } = await import("../src/middleware/startOnCallbackOrigin.js");
const { default: userAuthRouter, createGoogleSignInCallbackHandler } = await import("../src/routes/userAuthRouter.js");
const { isGoogleSignInCallback } = await import("../src/services/googleSignInService.js");
const { UserAuthError } = await import("../src/services/userAuthService.js");

const SITE = new Set(["cloudaicore.com", "www.cloudaicore.com", "novariumai.com", "www.novariumai.com"]);

// The routes in server.js's order.
function site({ hop, linked }) {
  const callback = createGoogleSignInCallbackHandler({
    // The same state check as finishGoogleSignIn, then Google says: this account.
    finish: async ({ state, cookieHeader }) => {
      if (!isGoogleSignInCallback({ state, cookieHeader })) {
        throw new UserAuthError("state", 400, "AUTH_GOOGLE_STATE_INVALID");
      }
      return {
        user: { id: "picked-google-account", authProvider: "identity-platform" },
        session: { access_token: "a", refresh_token: "r", expires_at: 9_999_999_999 },
      };
    },
    getSession: async (id) => (id === "owner-gh" ? { login: "owner-login" } : null),
    linkOwner: async (user) => linked.push(user.id),
    logError: () => {},
  });
  const app = express();
  if (hop) app.use(startOnCallbackOrigin());
  app.use("/api/auth", userAuthRouter);
  app.get("/api/google/callback", (req, res, next) =>
    isGoogleSignInCallback({ state: req.query.state, cookieHeader: req.headers.cookie })
      ? callback(req, res)
      : next(),
  );
  // Stands in for the Drive/Gmail callback, whose own state cookie a sign-in never sets.
  app.use("/api/google", (_req, res) => res.redirect(302, "/?google=error"));
  return app;
}

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
  for (let step = 0; step < 6; step += 1) {
    if (!SITE.has(url.host)) return url;
    const response = await request(app)
      .get(`${url.pathname}${url.search}`)
      .set("Host", url.host)
      .set("Cookie", jar.header(url.host, url.pathname));
    for (const cookie of [].concat(response.headers["set-cookie"] || [])) jar.set(url.host, cookie);
    if (response.status < 300 || response.status >= 400) return url;
    url = new URL(response.headers.location, url);
  }
  return url;
}

// Press „Продължи с Google“ on one name, pick an account at Google, come back.
async function signIn({ hop, start, ownerSessionOn }) {
  const linked = [];
  const app = site({ hop, linked });
  const jar = cookieJar();
  if (ownerSessionOn) jar.set(ownerSessionOn, "synchron_github_session=owner-gh; Path=/; HttpOnly; Secure; SameSite=Lax");
  const atGoogle = await follow(app, jar, start);
  assert.equal(atGoogle.host, "accounts.google.com");
  const back = new URL(atGoogle.searchParams.get("redirect_uri"));
  back.search = new URLSearchParams({ code: "c", state: atGoogle.searchParams.get("state") }).toString();
  const end = await follow(app, jar, back.href);
  return { end: end.href, linked, cookies: jar.names(end.host) };
}

process.env.GOOGLE_REDIRECT_URI = "https://cloudaicore.com/api/google/callback";

test("today a Google sign-in pressed on novariumai.com fails without the move and works with it", async () => {
  const before = await signIn({ hop: false, start: "https://novariumai.com/api/auth/google/start" });
  assert.equal(before.end, "https://cloudaicore.com/?google=error");
  const after = await signIn({ hop: true, start: "https://novariumai.com/api/auth/google/start" });
  assert.equal(after.end, "https://cloudaicore.com/");
  assert.ok(after.cookies.includes("synchron_user_session"), after.cookies.join(","));
});

test("a moved Google sign-in never links the account picked at Google to the owner", async () => {
  // The owner's GitHub session is on the name Google returns to; someone
  // presses „Продължи с Google“ on the other name and picks their account.
  for (const start of ["https://novariumai.com/api/auth/google/start", "https://www.cloudaicore.com/api/auth/google/start"]) {
    const moved = await signIn({ hop: true, start, ownerSessionOn: "cloudaicore.com" });
    assert.deepEqual(moved.linked, [], start);
    assert.equal(moved.end, "https://cloudaicore.com/", start);
  }
  // Started on the name with the owner session, it links as before.
  const same = await signIn({ hop: true, start: "https://cloudaicore.com/api/auth/google/start", ownerSessionOn: "cloudaicore.com" });
  assert.deepEqual(same.linked, ["picked-google-account"]);
  assert.equal(same.end, "https://cloudaicore.com/?owner_google_linked=1");
});

test("after the return address moves, the old name sends the sign-in to novariumai.com, again without an owner link", async () => {
  process.env.GOOGLE_REDIRECT_URI = "https://novariumai.com/api/google/callback";
  try {
    const moved = await signIn({ hop: true, start: "https://cloudaicore.com/api/auth/google/start", ownerSessionOn: "novariumai.com" });
    assert.equal(moved.end, "https://novariumai.com/");
    assert.deepEqual(moved.linked, []);
    const same = await signIn({ hop: true, start: "https://novariumai.com/api/auth/google/start", ownerSessionOn: "novariumai.com" });
    assert.deepEqual(same.linked, ["picked-google-account"]);
  } finally {
    process.env.GOOGLE_REDIRECT_URI = "https://cloudaicore.com/api/google/callback";
  }
});

test("in the real app the move sits before the sign-in routes and a connect without sign-in signs in first", async () => {
  const { default: app } = await import("../server.js");
  const pressed = await request(app).get("/api/auth/google/start").set("Host", "novariumai.com");
  assert.equal(pressed.status, 302);
  assert.equal(pressed.headers.location, "https://cloudaicore.com/api/auth/google/start?moved=1");
  assert.equal(pressed.headers["cache-control"], "no-store");
  assert.equal(pressed.headers["set-cookie"], undefined);
  const started = await request(app).get("/api/auth/google/start?moved=1").set("Host", "cloudaicore.com");
  assert.equal(started.status, 302);
  const google = new URL(started.headers.location);
  assert.equal(google.host, "accounts.google.com");
  assert.equal(google.searchParams.get("redirect_uri"), "https://cloudaicore.com/api/google/callback");
  assert.match(google.searchParams.get("state"), /^moved\./u);
  assert.ok([].concat(started.headers["set-cookie"]).some((cookie) => cookie.startsWith("synchron_google_signin_state=moved.")));
  // Connecting Google with nobody signed in goes to the sign-in first, on the
  // name the sign-in comes back to (src/middleware/signInFirst.js), never bare
  // JSON. A signed-in connect is left where it was pressed (tests above).
  const connect = await request(app).get("/api/google/connect?add=gmail").set("Host", "novariumai.com");
  assert.equal(connect.status, 302);
  assert.equal(connect.headers.location, "https://cloudaicore.com/api/google/connect?add=gmail");
  const there = await request(app).get("/api/google/connect?add=gmail").set("Host", "cloudaicore.com");
  assert.equal(there.status, 302);
  assert.equal(there.headers.location, "/api/auth/google/start");
  assert.ok([].concat(there.headers["set-cookie"]).some((cookie) => cookie.startsWith("novarium_after_signin=")));
});
