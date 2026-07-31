import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    "/assets/20260801-profile-actions/app.js",
    "/assets/20260730-connections-v1/work-center.js",
  ]);

  for (const assetUrl of assetUrls) {
    const response = await request(app).get(assetUrl);
    assert.equal(response.status, 200, assetUrl);
    assert.equal(response.headers["cache-control"], "no-store, max-age=0");
    assert.match(response.headers["content-type"], /javascript/u);
  }
});

test("a new safe version serves only the current allowlisted application assets", async () => {
  const [currentApp, currentWorkCenter] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/work-center.js", import.meta.url), "utf8"),
  ]);

  const appResponse = await request(app).get(
    "/assets/20991231-future-release/app.js",
  );
  assert.equal(appResponse.status, 200);
  assert.equal(appResponse.text, currentApp);
  assert.equal(appResponse.headers["cache-control"], "no-store, max-age=0");

  const workCenterResponse = await request(app).get(
    "/assets/20991231-future-release/work-center.js",
  );
  assert.equal(workCenterResponse.status, 200);
  assert.equal(workCenterResponse.text, currentWorkCenter);
  assert.equal(
    workCenterResponse.headers["cache-control"],
    "no-store, max-age=0",
  );
});

test("versioned application asset routes reject unknown files and unsafe versions", async () => {
  await request(app)
    .get("/assets/20991231-future-release/unknown.js")
    .expect(404);
  await request(app).get("/assets/%21unsafe/app.js").expect(404);
  await request(app).get("/assets/safe/%2e%2e").expect(404);
});
