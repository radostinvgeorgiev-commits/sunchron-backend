import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (v) => createHash("sha256").update(v).digest();
export function createHttpServer({ bridge, token }) {
  if (typeof token !== "string" || token.length < 32)
    throw new Error("A strong bridge bearer token is required");
  const expected = digest(`Bearer ${token}`);
  let minute = 0;
  let requests = 0;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const respond = (status, body) => {
      res.writeHead(status);
      res.end(body == null ? undefined : JSON.stringify(body));
    };
    // This listener is loopback-only behind a TLS reverse proxy. It is a
    // single-owner service, not a multi-tenant or public WhatsApp gateway.
    if (req.url === "/health" && req.method === "GET")
      return respond(200, {
        process: "running",
        integration_acceptance: "unverified",
      });
    if (req.url !== "/mcp" || req.method !== "POST")
      return respond(405, { error: "Use POST /mcp" });
    if (!timingSafeEqual(digest(req.headers.authorization || ""), expected))
      return respond(401, { error: "Unauthorized" });
    if (
      req.headers.origin &&
      !["https://chatgpt.com", "https://cloudaicore.com"].includes(
        req.headers.origin,
      )
    )
      return respond(403, { error: "Origin denied" });
    if (
      !String(req.headers["content-type"] || "").startsWith("application/json")
    )
      return respond(415, { error: "JSON required" });
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) {
      minute = current;
      requests = 0;
    }
    if (++requests > 120) return respond(429, { error: "Rate limited" });
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) {
          respond(413, { error: "Request too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return respond(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" },
        });
      }
      const result = await bridge.rpc(body, req.headers["mcp-session-id"]);
      if (result.sessionId) res.setHeader("Mcp-Session-Id", result.sessionId);
      return respond(result.status || 200, result.body);
    } catch {
      if (!res.headersSent) respond(500, { error: "Bridge unavailable" });
    }
  });
}
