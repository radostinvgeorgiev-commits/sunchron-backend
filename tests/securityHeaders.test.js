import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../server.js";

test("public responses include the required security headers", async () => {
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(
    response.headers["strict-transport-security"],
    "max-age=31536000; includeSubDomains",
  );
  assert.equal(
    response.headers["referrer-policy"],
    "strict-origin-when-cross-origin",
  );
  assert.equal(
    response.headers["cross-origin-opener-policy"],
    "same-origin",
  );
  assert.equal(
    response.headers["cross-origin-resource-policy"],
    "same-origin",
  );
  assert.match(
    response.headers["permissions-policy"],
    /camera=\(\).*microphone=\(\).*payment=\(\)/,
  );

  const csp = response.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /connect-src 'self'/);
});

test("private unauthorized responses keep the same security boundary", async () => {
  const response = await request(app).get("/memory");

  assert.equal(response.status, 401);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(
    response.headers["content-security-policy"],
    /frame-ancestors 'none'/,
  );
});
