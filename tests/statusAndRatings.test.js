import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createPublicStatusHandler } from "../src/routes/health.js";

function call(handler) {
  return new Promise((resolve) => {
    const headers = {};
    handler({}, { setHeader: (k, v) => (headers[k] = v), json: (body) => resolve({ body, headers }) });
  });
}
const probe = (rows) => async () => rows;

test("public status reports ok, partial and down without internal details", async () => {
  const all = await call(createPublicStatusHandler({
    ready: async () => true,
    probe: probe([
      { label: "Claude", configured: true, working: true, reason: null, model: "m" },
      { label: "Vertex", configured: false, working: false, reason: "няма ключ" },
    ]),
  }));
  assert.equal(all.body.status, "ok");
  assert.deepEqual(all.body.models, [{ name: "Claude", working: true }]);
  assert.match(all.headers["Cache-Control"], /max-age=60/u);

  const partial = await call(createPublicStatusHandler({
    ready: async () => true,
    probe: probe([
      { label: "Claude", configured: true, working: true },
      { label: "Gemini", configured: true, working: false, reason: "503 secret detail" },
    ]),
  }));
  assert.equal(partial.body.status, "partial");
  assert.doesNotMatch(JSON.stringify(partial.body), /secret detail/u);

  const down = await call(createPublicStatusHandler({
    ready: async () => { throw new Error("x"); },
    probe: probe([{ label: "Claude", configured: true, working: true }]),
  }));
  assert.equal(down.body.status, "down");
  assert.equal(down.body.site, false);
});

test("status page, owner ratings and the owner's working rule are in place", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../server.js"), /app\.get\("\/status"/u);
  assert.doesNotMatch(read("../public/status.html"), /<script>(?!<\/script>)/u);
  assert.match(read("../public/status.js"), /fetch\("\/health\/status"/u);
  assert.match(read("../public/ai-spend.js"), /fetch\("\/api\/feedback\/summary"/u);
  assert.match(read("../AGENTS.md"), /агентът работи автономно и води/u);
  assert.match(read("../src/routes/chat.js"), /Основно правило на Радко: ти водиш/u);
});
