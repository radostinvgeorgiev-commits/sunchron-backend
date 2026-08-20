import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, index, styles] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/appshell.css", import.meta.url), "utf8"),
]);

test("owner interface exposes a protected system configuration panel", () => {
  assert.match(index, /id="systemConfigurationBtn"/u);
  assert.match(app, /\/api\/system\/configuration/u);
  assert.match(app, /Тайна стойност · никога не се показва/u);
  assert.match(app, /Google Cloud runtime/u);
  assert.match(app, /Защитен заместител/u);
  assert.match(app, /configuration\.production/u);
  assert.match(styles, /\.configuration-group/u);
});

test("system configuration UI never renders a server-side value field", () => {
  assert.doesNotMatch(app, /item\.(?:value|secret|token|password)/u);
  assert.doesNotMatch(app, /configuration\.environment[^;]+\.value/u);
});
