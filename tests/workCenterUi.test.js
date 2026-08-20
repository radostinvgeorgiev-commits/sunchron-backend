import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../public/work-center.js", import.meta.url);
const htmlUrl = new URL("../public/index.html", import.meta.url);

test("work center shows the canonical MCP address as visible text", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /https:\/\/cloudaicore\.com\/mcp/u);
  assert.match(source, /Постави точно този адрес/u);
});

test("work center exposes Google Cloud and Identity Platform management", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /Google Cloud/u);
  assert.match(source, /Identity Platform/u);
  assert.match(source, /console\.cloud\.google\.com/u);
});

test("work center contains no retired provider or domain actions", async () => {
  const [source, html] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(htmlUrl, "utf8"),
  ]);
  const activeUi = `${source}\n${html}`;
  assert.doesNotMatch(activeUi, /synchron\.foundation|DigitalOcean|Cloudflare/iu);
  assert.doesNotMatch(activeUi, /prepare-www|confirm-www|www-domain/iu);
});

test("work center links Google apps and protected GitHub actions", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /google-drive/u);
  assert.match(source, /google-calendar/u);
  assert.match(source, /github-confirmed-write/u);
  assert.match(source, /точно потвърждение/iu);
});
