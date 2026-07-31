import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

process.env.NODE_ENV = "test";
const { default: app } = await import("../server.js");

test("versioned application assets referenced by HTML are served", async () => {
  const index = await request(app).get("/");
  assert.equal(index.status, 200);

  const assetUrls = [
    ...index.text.matchAll(
      /<script src="(\/assets\/[^"]+\/(?:app|work-center)\.js)"><\/script>/gu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(assetUrls, [
    "/assets/20260730-opensearch-status-v1/app.js",
    "/assets/20260730-connections-v1/work-center.js",
  ]);

  for (const assetUrl of assetUrls) {
    const response = await request(app).get(assetUrl);
    assert.equal(response.status, 200, assetUrl);
    assert.equal(response.headers["cache-control"], "no-store, max-age=0");
    assert.match(response.headers["content-type"], /javascript/u);
  }
});
