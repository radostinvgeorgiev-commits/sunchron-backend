import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");

test("AI CORE is installable: manifest, icons, service worker", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  const html = read("index.html");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/u);
  assert.match(html, /src="\/pwa\.js/u);
  assert.doesNotMatch(html, /<script>\s*if \("serviceWorker"/u);
});

test("the service worker never caches the app or API, only the offline page", () => {
  const sw = read("sw.js");
  assert.match(sw, /event\.request\.mode !== "navigate"/u);
  assert.match(sw, /cache\.addAll\(\[OFFLINE_URL, "\/icon-192\.png"\]\)/u);
  assert.doesNotMatch(read("offline.html"), /onclick=/u);
});
