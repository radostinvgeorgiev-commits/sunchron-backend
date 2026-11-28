import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { redirectOldSiteName } from "../src/middleware/redirectOldSiteName.js";

// One request through the middleware: [status, address, cache, vary] when it
// redirects, "next" when it lets the request through, "nothing" otherwise.
const run = ({ method = "GET", host, url, dest, path = url.replace(/\?.*$/u, ""), options }) => {
  let redirect = null;
  let passed = false;
  const headers = {};
  const requestHeaders = { host, "sec-fetch-dest": dest };
  redirectOldSiteName(options)(
    { method, path, originalUrl: url, get: (name) => requestHeaders[name.toLowerCase()] },
    {
      set: (name, value) => (headers[name.toLowerCase()] = value),
      redirect: (status, to) => (redirect = [status, to, headers["cache-control"], headers.vary]),
    },
    () => (passed = true),
  );
  return redirect || (passed ? "next" : "nothing");
};
const moved = (to) => [301, to, "public, max-age=86400", "Sec-Fetch-Dest"];

test("a page on the old name moves for good to novariumai.com, same path and query", () => {
  for (const host of ["cloudaicore.com", "www.cloudaicore.com", "CloudAICore.com", "cloudaicore.com:443"]) {
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
  await request(app).head("/register").set("Host", "cloudaicore.com").expect(301);
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
