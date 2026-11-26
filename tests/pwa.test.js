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

// A phone kept an old page in memory for days. Coming back to the screen,
// the page reloads itself when a newer version is live, but not mid-typing.
test("an open page reloads itself when a newer version is live, unless the person is typing", async () => {
  const { JSDOM } = await import("jsdom");
  const run = async ({ typed = "" } = {}) => {
    const dom = new JSDOM(
      `<textarea id="chatInput">${typed}</textarea><button id="sendBtn"></button>`,
      { runScripts: "outside-only", pretendToBeVisual: true, url: "https://cloudaicore.com/" },
    );
    const { window } = dom;
    let commit = "old";
    let reloads = 0;
    let now = 1_000_000;
    window.fetch = async () => ({ ok: true, json: async () => ({ commit }) });
    window.Date.now = () => now;
    window.__reload = () => reloads++;
    window.setInterval = () => 0;
    window.eval(read("pwa.js").replace(/\blocation\.reload\(\)/u, "window.__reload()"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    commit = "new";
    now += 120_000;
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return reloads;
  };
  assert.equal(await run(), 1);
  assert.equal(await run({ typed: "половин изречение" }), 0);
});
