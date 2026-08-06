import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("connection and permission controls lead to real setup actions", async () => {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );

  assert.match(app, /data-connect-service="google"/u);
  assert.match(app, /window\.location\.href = "\/api\/google\/connect"/u);
  assert.match(app, /data-connect-service="github"/u);
  assert.match(app, /window\.location\.href = "\/api\/github\/connect"/u);
  assert.match(app, /data-disconnect-service/u);
  assert.match(app, /\/api\/google\/disconnect/u);
  assert.match(app, /\/api\/github\/disconnect/u);
  assert.match(app, /GitHub Read работи/u);
  assert.match(app, /GitHub Write е изключен в текущия режим без Copilot/u);
  assert.match(
    app,
    /Не са нужни нов GitHub App, App ID, Installation ID, private key, token или production secret/u,
  );
  assert.doesNotMatch(app, /GITHUB_CLIENT_ID/u);
  assert.doesNotMatch(app, /GITHUB_CLIENT_SECRET/u);
  assert.doesNotMatch(app, /Регистрирай GitHub App/u);
  assert.doesNotMatch(app, /personal-access-tokens/u);
  assert.doesNotMatch(app, /GITHUB_TOKEN/u);
  assert.match(app, /data-permission-info/u);
  assert.match(app, /Оранжевото също работи, но пита/u);
});
