import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("connection and permission controls lead to real setup actions", async () => {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const googleDrive = await readFile(
    new URL("../public/google-drive.js", import.meta.url),
    "utf8",
  );
  const googleApps = await readFile(
    new URL("../public/google-apps.js", import.meta.url),
    "utf8",
  );

  assert.match(app, /data-connect-service="google"/u);
  assert.match(app, /window\.location\.href = "\/api\/google\/connect"/u);
  assert.match(googleDrive, /window\.location\.href = "\/api\/google\/restore"/u);
  assert.match(googleApps, /window\.location\.href = "\/api\/google\/restore"/u);
  assert.match(app, /function requiresGoogleOAuth\(tool\)/u);
  assert.match(app, /"google-drive-read"/u);
  assert.match(app, /"google-calendar-read"/u);
  assert.match(app, /"google-calendar-write"/u);
  assert.match(app, /"gmail-read"/u);
  assert.match(app, /"google-contacts"/u);
  assert.doesNotMatch(
    app,
    /function requiresGoogleOAuth\(tool\)[\s\S]*?tool\?\.provider === "google"/u,
  );
  assert.match(app, /data-connect-service="github"/u);
  assert.match(app, /window\.location\.href = "\/api\/github\/connect"/u);
  assert.match(app, /<strong>ChatGPT<\/strong>/u);
  assert.match(app, /chatgptConnected \? "disconnect" : "connect"/u);
  assert.match(app, /window\.open\("https:\/\/chatgpt\.com\/"/u);
  assert.match(app, /fetch\("\/permissions\/oauth\/chatgpt"/u);
  assert.match(app, /\/permissions\/oauth\/chatgpt\/revoke/u);
  assert.match(app, /JSON\.stringify\(\{ all: true \}\)/u);
  assert.match(app, /Да отнема ли всички активни права на ChatGPT/u);
  assert.match(app, /data-disconnect-service/u);
  assert.match(app, /\/api\/google\/disconnect/u);
  assert.match(app, /\/api\/github\/disconnect/u);
  assert.match(app, /GitHub Read проверява/u);
  assert.match(app, /AI CORE Code Write подготвя отделен branch/u);
  assert.match(
    app,
    /Не поставяй token или private key в чата/u,
  );
  assert.doesNotMatch(app, /GITHUB_CLIENT_ID/u);
  assert.doesNotMatch(app, /GITHUB_CLIENT_SECRET/u);
  assert.doesNotMatch(app, /Регистрирай GitHub App/u);
  assert.doesNotMatch(app, /personal-access-tokens/u);
  assert.doesNotMatch(app, /GITHUB_TOKEN/u);
  assert.match(app, /data-permission-info/u);
  assert.match(app, /Оранжевото също работи, но пита/u);
});

