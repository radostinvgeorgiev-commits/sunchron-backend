import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(
  new URL("../public/units-ring.js", import.meta.url),
  "utf8",
);

function harness(response) {
  const dom = new JSDOM(
    `<!doctype html><body><header class="chat-toolbar"><div class="status-indicator"></div></header></body>`,
    { url: "https://novariumai.com", runScripts: "outside-only" },
  );
  const calls = [];
  dom.window.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: response.status === 200,
      status: response.status,
      json: async () => response.body,
    };
  };
  dom.window.eval(script);
  return { dom, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("members see a ring that fills as units are spent", async () => {
  const { dom, calls } = harness({
    status: 200,
    body: { remaining: 25, allowance: 100, expiresAt: Date.UTC(2026, 11, 28), owner: false },
  });
  dom.window.document.dispatchEvent(new dom.window.CustomEvent("novarium:signed-in"));
  await tick();
  const ring = dom.window.document.getElementById("unitsRing");
  assert.deepEqual(calls, ["/api/product/usage"]);
  assert.equal(ring.hidden, false);
  assert.equal(ring.dataset.level, "mid");
  assert.equal(ring.querySelector(".ai-spend-percent").textContent, "25");
  assert.match(ring.querySelector(".ai-spend-total").textContent, /Остават 25 от 100 AI единици/);
  assert.equal(ring.querySelector(".units-ring-more").getAttribute("href"), "/plans");
  const offset = Number(ring.querySelector(".ai-spend-fill").getAttribute("stroke-dashoffset"));
  const full = 2 * Math.PI * 15;
  assert.ok(Math.abs(offset - full * 0.25) < 0.01);
  dom.window.NovariumUnitsRing.start(); // restart clears the old timer
  dom.window.close();
});

test("the owner and signed-out visitors see no ring", async () => {
  for (const response of [
    { status: 200, body: { owner: true, remaining: null } },
    { status: 401, body: {} },
  ]) {
    const { dom } = harness(response);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent("novarium:signed-in"));
    await tick();
    assert.equal(dom.window.document.getElementById("unitsRing").hidden, true);
    dom.window.close();
  }
});
