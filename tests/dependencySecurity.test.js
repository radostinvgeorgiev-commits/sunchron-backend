import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createApiRateLimiter } from "../src/middleware/rateLimits.js";

test("forwarded IPv6 clients share a subnet limit and preserve client isolation", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createApiRateLimiter({ limit: 2, windowMs: 60_000 }));
  app.get("/", (_req, res) => res.json({ ok: true }));
  const send = (ip) => request(app).get("/").set("X-Forwarded-For", ip);
  await send("2001:db8:1234:5600::1").expect(200);
  await send("2001:db8:1234:5600::2").expect(200);
  await send("2001:db8:1234:5601::3").expect(429);
  await send("2001:db8:1234:5700::1").expect(200);
  await send("192.0.2.1").expect(200);
  await send("192.0.2.2").expect(200);
  await send("192.0.2.1").expect(200);
  await send("192.0.2.1").expect(429);
});

test("compressed JSON with trailing garbage cannot terminate the HTTP process", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import express from "express";
    import http from "node:http";
    import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.post("/", (req, res) => res.json(req.body));
    app.use((error, _req, res, _next) => res.status(error.status || 500).end());
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    async function send(body, encoding, trailing = null) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: server.address().port,
          path: "/", method: "POST", headers: { "content-type": "application/json",
          "content-encoding": encoding, "content-length": body.length + (trailing?.length || 0) } }, res => {
          let text = ""; res.on("data", chunk => text += chunk);
          res.on("end", () => resolve({ status: res.statusCode, text }));
        });
        req.on("error", reject);
        if (trailing) { req.write(body); setTimeout(() => req.end(trailing), 50); }
        else req.end(body);
      });
    }
    try {
      for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
        const valid = compress(Buffer.from('{"ok":true}'));
        assert.equal((await send(valid, encoding)).status, 200);
        const malformed = await send(valid, encoding, Buffer.from([255, 255, 255, 255]));
        assert.ok([200, 400].includes(malformed.status));
        // Some decoders ignore trailing bytes. Either outcome must leave the server usable.
        await new Promise(resolve => setTimeout(resolve, 100));
        const control = await send(Buffer.from('{"ok":true}'), "identity");
        assert.equal(control.status, 200);
        assert.deepEqual(JSON.parse(control.text), { ok: true });
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
