import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("connection and permission controls lead to real setup actions", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(app, /data-connect-service="google"/u);
  assert.match(app, /window\.location\.href = "\/api\/google\/connect"/u);
  assert.match(app, /data-connect-service="github"/u);
  assert.match(app, /github\.com\/settings\/personal-access-tokens\/new/u);
  assert.match(app, /cloud\.digitalocean\.com\/apps/u);
  assert.match(app, /GITHUB_TOKEN/u);
  assert.match(app, /data-permission-info/u);
  assert.match(app, /Оранжевото също работи, но пита/u);
});
