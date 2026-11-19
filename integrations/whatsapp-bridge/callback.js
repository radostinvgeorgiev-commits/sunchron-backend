import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";

export function publicIPv4(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(address)) return false;
  const p = address.split(".").map(Number);
  if (p.some((n) => n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function validateCallback(value, allowedHosts) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !allowedHosts.includes(url.hostname)
  ) {
    throw new Error("Callback must use an explicitly allowed HTTPS hostname");
  }
  return url;
}

export function signingKey(secret) {
  if (
    typeof secret !== "string" ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(secret)
  )
    throw new Error("Invalid webhook secret");
  const raw = secret.slice(6);
  const key = Buffer.from(raw, "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")
  )
    throw new Error("Invalid webhook secret");
  return key;
}

export function sign(secret, eventId, timestamp, body) {
  return `v1,${createHmac("sha256", signingKey(secret)).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

// Exact hostname allowlist AND connection-time IP validation. DNS is resolved
// once per connection and pinned; TLS still checks the original hostname.
// IPv6-only callbacks fail closed. Redirects are never followed.
export function createCallbackSender(
  allowedHosts,
  { resolve = lookup, request = https.request } = {},
) {
  return async (subscription, payload, id) => {
    const url = validateCallback(subscription.url, allowedHosts);
    const addresses = await resolve(url.hostname, { all: true, family: 4 });
    if (
      !addresses.length ||
      addresses.some((a) => a.family !== 4 || !publicIPv4(a.address))
    )
      throw new Error(
        "Callback destination is not a supported public IPv4 host",
      );
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 262144)
      throw new Error("Event exceeds 256 KiB");
    const timestamp = String(Math.floor(Date.now() / 1000));
    return new Promise((resolveResponse, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          agent: false,
          lookup: (_host, options, cb) =>
            options?.all
              ? cb(null, [addresses[0]])
              : cb(null, addresses[0].address, 4),
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "webhook-id": id,
            "webhook-timestamp": timestamp,
            "webhook-signature": sign(subscription.secret, id, timestamp, body),
            "X-MCP-Subscription-Id": subscription.id,
          },
        },
        (res) => {
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 65536)
              res.destroy(new Error("Callback response too large"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolveResponse({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.setTimeout(10000, () => req.destroy(new Error("Callback timeout")));
      req.on("error", reject);
      req.end(body);
    });
  };
}
