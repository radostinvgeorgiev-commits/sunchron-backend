import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { redirectOldSiteName } from "../src/middleware/redirectOldSiteName.js";

// What a browser sends when it opens a page, and what fetch() sends.
const PAGE = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
// Sign-ins end on novariumai.com (Cloud Run since 28.11); the old setting.
const NEW_SIGN_IN = {
  GOOGLE_REDIRECT_URI: "https://novariumai.com/api/google/callback",
  GITHUB_REDIRECT_URI: "https://novariumai.com/api/github/callback",
};
const OLD_SIGN_IN = {
  GOOGLE_REDIRECT_URI: "https://cloudaicore.com/api/google/callback",
  GITHUB_REDIRECT_URI: "https://cloudaicore.com/api/github/callback",
};

// One request through the middleware: [status, address, cache] when it
// redirects, "next" when it lets the request through, "nothing" otherwise.
// Without a dest it is a browser without Sec-Fetch-Dest or a search engine.
const run = ({
  method = "GET",
  host,
  url,
  dest,
  accept = dest ? "*/*" : PAGE,
  cookie,
  path = url.replace(/\?.*$/u, ""),
  options = {},
}) => {
  let redirect = null;
  let passed = false;
  const headers = {};
  const requestHeaders = { host, "sec-fetch-dest": dest, accept, cookie };
  redirectOldSiteName({ env: NEW_SIGN_IN, ...options })(
    { method, path, originalUrl: url, get: (name) => requestHeaders[name.toLowerCase()] },
    {
      set: (name, value) => (headers[name.toLowerCase()] = value),
      redirect: (status, to) => (redirect = [status, to, headers["cache-control"]]),
    },
    () => (passed = true),
  );
  return redirect || (passed ? "next" : "nothing");
};
const moved = (to) => [301, to, "no-store"];

test("a page on the old name moves for good to novariumai.com, same path and query", () => {
  for (const host of ["cloudaicore.com", "www.cloudaicore.com", "CloudAICore.com", "cloudaicore.com:443", "cloudaicore.com.", "www.cloudaicore.com."]) {
    assert.deepEqual(run({ host, url: "/developers" }), moved("https://novariumai.com/developers"), host);
    assert.deepEqual(
      run({ host, url: "/plans?lang=en&ref=mail" }),
      moved("https://novariumai.com/plans?lang=en&ref=mail"),
      host,
    );
  }
  // A browser opening a page, a search engine or a link from another program
  // (no Sec-Fetch-Dest), and HEAD as well as GET.
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/help", dest: "document" }), moved("https://novariumai.com/help"));
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/s/abc123" }), moved("https://novariumai.com/s/abc123"));
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/index.html" }), moved("https://novariumai.com/index.html"));
  assert.deepEqual(run({ method: "HEAD", host: "cloudaicore.com", url: "/register" }), moved("https://novariumai.com/register"));
});

test("until Google approves, the start page, „Поверителност“ and „Общи условия“ stay on the old name", () => {
  for (const url of ["/", "/?lang=en", "/privacy", "/privacy/", "/terms", "/Terms"]) {
    assert.equal(run({ host: "cloudaicore.com", url, dest: "document" }), "next", url);
    assert.equal(run({ host: "www.cloudaicore.com", url }), "next", url);
  }
  // After the approval they move like every other page.
  const after = { keepGoogleReviewPages: false };
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/", options: after }), moved("https://novariumai.com/"));
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/privacy?lang=en", options: after }), moved("https://novariumai.com/privacy?lang=en"));
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/terms", options: after }), moved("https://novariumai.com/terms"));
  // Pages that only start with those names are ordinary pages.
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/privacy-choices" }), moved("https://novariumai.com/privacy-choices"));
});

test("novariumai.com and every other name answer as before", () => {
  for (const host of ["novariumai.com", "www.novariumai.com", "synchron-backend-google-abc-ew.a.run.app", "localhost:3000", "", undefined]) {
    assert.equal(run({ host, url: "/plans" }), "next", String(host));
  }
});

test("the sign-in returns, sign-in starts, the API, the AI connectors and the health checks stay on the old name", () => {
  for (const url of [
    "/api/google/callback?code=x&state=y",
    "/api/github/callback?code=x&state=y",
    "/api/auth/google/callback?code=x&state=y",
    "/api/auth/google/start",
    "/API/Google/Callback?code=x",
    "/api/product/webhook",
    "/api/workspaces",
    "/api",
    "/mcp",
    "/mcp/chatgpt",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/authorize?client_id=x",
    "/health",
    "/health/ready",
  ]) {
    assert.equal(run({ host: "cloudaicore.com", url, dest: "document" }), "next", url);
    assert.equal(run({ host: "cloudaicore.com", url }), "next", url);
  }
});

test("the app's own calls outside /api and the owner's lists stay on the old name", () => {
  for (const url of [
    "/chat/models",
    "/chat/assistants",
    "/memory/conversations",
    "/memory/profile",
    "/permissions/oauth/chatgpt",
    "/cloud/status",
    "/github/status",
    "/calendar/events",
    "/search?q=x",
    "/admin/contact",
    "/admin/early-access",
    "/Memory/Conversations",
  ]) {
    // fetch() from a browser without Sec-Fetch-Dest (Safari before 16.4), a
    // browser that sends it, and the owner opening a list in a new tab.
    assert.equal(run({ host: "cloudaicore.com", url, accept: "*/*" }), "next", url);
    assert.equal(run({ host: "cloudaicore.com", url, dest: "empty" }), "next", url);
    assert.equal(run({ host: "cloudaicore.com", url, dest: "document" }), "next", url);
    assert.equal(run({ host: "cloudaicore.com", url }), "next", url);
  }
  // A page whose name only starts with one of those words is an ordinary page.
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/chatbots" }), moved("https://novariumai.com/chatbots"));
  assert.deepEqual(run({ host: "cloudaicore.com", url: "/searching" }), moved("https://novariumai.com/searching"));
});

test("without Sec-Fetch-Dest a page moves by its path, whatever it asks for: Bing asks for anything", () => {
  // null: no Accept header at all. Bingbot sends */* and no Sec-Fetch-Dest.
  for (const accept of ["*/*", "application/json", "", null, "text/html", "TEXT/HTML", "application/xhtml+xml, text/html;q=0.9"]) {
    assert.deepEqual(run({ host: "cloudaicore.com", url: "/plans", accept }), moved("https://novariumai.com/plans"), String(accept));
    assert.deepEqual(run({ host: "cloudaicore.com", url: "/s/AbCd123", accept }), moved("https://novariumai.com/s/AbCd123"), String(accept));
  }
  // A file stays, whatever it asks for.
  for (const accept of ["*/*", "text/html", null]) {
    assert.equal(run({ host: "cloudaicore.com", url: "/robots.txt", accept }), "next", String(accept));
    assert.equal(run({ host: "cloudaicore.com", url: "/locales/de.json", accept }), "next", String(accept));
  }
});

test("while a sign-in still ends on the old name, a person signed in there stays there", () => {
  const oldGitHubOnly = { ...NEW_SIGN_IN, GITHUB_REDIRECT_URI: OLD_SIGN_IN.GITHUB_REDIRECT_URI };
  for (const cookie of ["synchron_user_session=abc", "theme=dark; synchron_github_session=xyz"]) {
    assert.equal(run({ host: "cloudaicore.com", url: "/plans", cookie, options: { env: OLD_SIGN_IN } }), "next", cookie);
    // GitHub's return alone still on the old name is enough.
    assert.equal(run({ host: "cloudaicore.com", url: "/plans", cookie, options: { env: oldGitHubOnly } }), "next", cookie);
    // Once every sign-in ends on novariumai.com, they move like everyone else.
    assert.deepEqual(run({ host: "cloudaicore.com", url: "/plans", cookie }), moved("https://novariumai.com/plans"), cookie);
  }
  // The guard follows where each sign-in really comes back, not only the
  // public address: Google's return still on the old name keeps them there
  // even when PUBLIC_ORIGIN already names novariumai.com.
  const publicNewGoogleOld = { ...NEW_SIGN_IN, PUBLIC_ORIGIN: "https://novariumai.com", GOOGLE_REDIRECT_URI: OLD_SIGN_IN.GOOGLE_REDIRECT_URI };
  assert.equal(
    run({ host: "cloudaicore.com", url: "/plans", cookie: "synchron_user_session=abc", options: { env: publicNewGoogleOld } }),
    "next",
  );
  // And the public address on the old name (Facebook and Microsoft come back there).
  const publicOld = { ...NEW_SIGN_IN, PUBLIC_ORIGIN: "https://cloudaicore.com" };
  assert.equal(run({ host: "cloudaicore.com", url: "/plans", cookie: "synchron_user_session=abc", options: { env: publicOld } }), "next");
  // Someone who is not signed in moves either way; an emptied cookie or one
  // with a longer name is not a sign-in.
  for (const cookie of [undefined, "theme=dark", "synchron_user_session=", "my_synchron_user_session=abc"]) {
    assert.deepEqual(
      run({ host: "cloudaicore.com", url: "/plans", cookie, options: { env: OLD_SIGN_IN } }),
      moved("https://novariumai.com/plans"),
      String(cookie),
    );
  }
});

test("only pages move: a page still open on the old name keeps loading its files", () => {
  for (const dest of ["script", "style", "image", "font", "empty", "serviceworker", "manifest"]) {
    assert.equal(run({ host: "cloudaicore.com", url: "/plans", dest }), "next", dest);
  }
  for (const url of ["/landing.js", "/app-neon.css", "/assets/20261127-media-v4/app.js", "/locales/de.json", "/sw.js", "/icon-192.png"]) {
    assert.equal(run({ host: "cloudaicore.com", url }), "next", url);
  }
});

test("only reading moves: a form or a webhook is never turned into a GET", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(run({ method, host: "cloudaicore.com", url: "/", dest: "document" }), "next", method);
  }
});

test("the new address never leaves novariumai.com", () => {
  for (const url of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/x"]) {
    assert.equal(run({ host: "cloudaicore.com", url, path: "/x" }), "next", url);
  }
});

test("the server moves the old name before any page or file is served", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const redirect = server.indexOf("app.use(redirectOldSiteName());");
  assert.ok(redirect > 0);
  for (const later of ['express.static("public"', 'app.get("/", ', "app.use(startOnCallbackOrigin());", '"/api/product/webhook"']) {
    assert.ok(server.indexOf(later) > redirect, later);
  }
});

test("the real site: the old name's pages move, its sign-in return, connectors and files stay", async () => {
  process.env.NODE_ENV = "test";
  const { default: request } = await import("supertest");
  const { default: app } = await import("../server.js");
  const page = await request(app)
    .get("/plans?lang=en")
    .set("Host", "www.cloudaicore.com")
    .set("Sec-Fetch-Dest", "document")
    .expect(301);
  assert.equal(page.headers.location, "https://novariumai.com/plans?lang=en");
  const head = await request(app).head("/register").set("Host", "cloudaicore.com").set("Accept", "text/html").expect(301);
  assert.equal(head.headers["cache-control"], "no-store");
  // A call of a page already open there, from a browser without
  // Sec-Fetch-Dest, is answered on the old name.
  const call = await request(app).get("/memory/conversations").set("Host", "cloudaicore.com").set("Accept", "*/*");
  assert.notEqual(call.status, 301);
  // Bing asks for anything and gets the move too.
  const bing = await request(app)
    .get("/plans")
    .set("Host", "cloudaicore.com")
    .set("Accept", "*/*")
    .set("User-Agent", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")
    .expect(301);
  assert.equal(bing.headers.location, "https://novariumai.com/plans");
  await request(app).get("/locales/de.json").set("Host", "cloudaicore.com").set("Accept", "*/*").expect(200);
  // The pages Google's reviewers open stay until Google approves.
  await request(app).get("/").set("Host", "cloudaicore.com").set("Sec-Fetch-Dest", "document").expect(200);
  await request(app).get("/privacy").set("Host", "cloudaicore.com").set("Sec-Fetch-Dest", "document").expect(200);
  // The same page on the new name is served as before.
  await request(app).get("/plans").set("Host", "novariumai.com").expect(200);
  // A file a page loads, the health check, a connector's discovery and a
  // sign-in return are answered on the old name itself.
  await request(app).get("/landing.js").set("Host", "cloudaicore.com").set("Sec-Fetch-Dest", "script").expect(200);
  await request(app).get("/health").set("Host", "cloudaicore.com").expect(200);
  const discovery = await request(app).get("/.well-known/oauth-authorization-server").set("Host", "cloudaicore.com");
  assert.notEqual(discovery.status, 301);
  const callback = await request(app).get("/api/google/callback?state=x&code=y").set("Host", "cloudaicore.com");
  assert.notEqual(callback.status, 301);
  assert.doesNotMatch(String(callback.headers.location || ""), /^https:\/\/novariumai\.com\/api\/google\/callback/u);
});
