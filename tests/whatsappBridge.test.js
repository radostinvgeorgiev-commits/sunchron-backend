import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../integrations/whatsapp-bridge/store.js";
import { createBridge } from "../integrations/whatsapp-bridge/bridge.js";
import { createHttpServer } from "../integrations/whatsapp-bridge/http.js";
import {
  createCallbackSender,
  publicIPv4,
  sign,
  validateCallback,
} from "../integrations/whatsapp-bridge/callback.js";

const chatId = "123456789@c.us";
const token = "a-test-only-bearer-token-with-at-least-32-characters";
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const eventParams = () => ({
  name: "whatsapp.message.created",
  arguments: { conversation_id: "beyza" },
  delivery: { mode: "webhook", url: "https://callback.example/events", secret },
});
const message = (id, overrides = {}) => ({
  id: { _serialized: id },
  from: chatId,
  to: "owner",
  fromMe: false,
  body: "Merhaba",
  timestamp: 1700000000,
  type: "chat",
  ...overrides,
});

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-bridge-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const path = join(directory, "state.enc");
  const store = await openStore(path, key);
  const client = new EventEmitter();
  const sent = [];
  client.sendMessage = async (to, text) => {
    sent.push({ to, text });
    return { id: { _serialized: "sent-1" } };
  };
  client.getChatById = async () => ({ fetchMessages: async () => [] });
  let clock = 1700000000000;
  const delivered = [];
  const sendCallback =
    options.sendCallback ||
    (async (subscription, payload) => {
      delivered.push({ subscription, payload });
      return {
        status: 200,
        body: JSON.stringify({ challenge: payload.challenge }),
      };
    });
  const bridge = createBridge({
    client,
    store,
    chatId,
    sendCallback,
    now: () => clock,
  });
  const first = await bridge.rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  let session = first.sessionId;
  const rpc = (method, params = {}, selectedSession = session) =>
    bridge.rpc({ jsonrpc: "2.0", id: 2, method, params }, selectedSession);
  const tool = (name, args = {}, selectedSession = session) =>
    rpc("tools/call", { name, arguments: args }, selectedSession);
  return {
    bridge,
    store,
    client,
    sent,
    delivered,
    path,
    key,
    rpc,
    tool,
    advance: (n) => {
      clock += n;
    },
    ready: () => client.emit("ready"),
  };
}

test("encrypted state survives restart, hides content, and serializes concurrent writes", async (t) => {
  const s = await setup(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      s.store.update((state) => state.messages.push({ text: `private-${i}` })),
    ),
  );
  assert.equal(s.store.read().messages.length, 20);
  assert.equal(
    (await readFile(s.path)).includes(Buffer.from("private-")),
    false,
  );
  assert.equal((await openStore(s.path, s.key)).read().messages.length, 20);
  await assert.rejects(openStore(s.path, randomBytes(32)), /decrypt/u);
});

test("monitoring requires pairing and verifies callbacks before storing subscriptions", async (t) => {
  const s = await setup(t);
  assert.ok((await s.rpc("events/subscribe", eventParams())).body.error);
  s.ready();
  const first = (await s.rpc("events/subscribe", eventParams())).body.result;
  const second = (await s.rpc("events/subscribe", eventParams())).body.result;
  assert.equal(first.id, second.id);
  assert.equal(Object.keys(s.store.read().subscriptions).length, 1);
  assert.equal(s.delivered[0].payload.type, "verification");
  const bad = await setup(t, {
    sendCallback: async () => ({ status: 200, body: '{"challenge":"wrong"}' }),
  });
  bad.ready();
  assert.equal(
    (await bad.rpc("events/subscribe", eventParams())).body.error.code,
    -32015,
  );
  assert.equal(Object.keys(bad.store.read().subscriptions).length, 0);
});

test("only incoming messages from the exact allowed chat trigger deduplicated events", async (t) => {
  const s = await setup(t);
  s.ready();
  await s.rpc("events/subscribe", eventParams());
  assert.equal(
    await s.bridge.ingest(message("other", { from: "999@c.us" })),
    false,
  );
  assert.equal(await s.bridge.ingest(message("one")), true);
  assert.equal(await s.bridge.ingest(message("one")), false);
  await s.bridge.ingest(message("out", { fromMe: true, to: chatId }));
  assert.equal(s.store.read().outbox.length, 1);
  await s.bridge.pump();
  assert.equal(s.store.read().outbox.length, 0);
  assert.equal(s.delivered.at(-1).payload.data.conversation_id, "beyza");
  assert.equal(s.delivered.at(-1).payload.data.text, "Merhaba");
  assert.equal(s.sent.length, 0);
});

test("send confirmation is exact, session-bound, expiring and cannot be replayed", async (t) => {
  const s = await setup(t);
  s.ready();
  const prepared = (
    await s.tool("whatsapp_prepare_reply", { text: "Seni özledim" })
  ).body.result.structuredContent;
  assert.equal(s.sent.length, 0);
  const confirm = {
    confirmation_id: prepared.confirmation_id,
    approved_text: prepared.text,
  };
  const otherSession = (
    await s.bridge.rpc({ jsonrpc: "2.0", id: 5, method: "initialize" })
  ).sessionId;
  assert.ok(
    (await s.tool("whatsapp_confirm_reply", confirm, otherSession)).body.error,
  );
  assert.ok(
    (
      await s.tool("whatsapp_confirm_reply", {
        ...confirm,
        approved_text: "changed",
      })
    ).body.error,
  );
  assert.equal(
    (await s.tool("whatsapp_confirm_reply", confirm)).body.result
      .structuredContent.sent,
    true,
  );
  assert.ok((await s.tool("whatsapp_confirm_reply", confirm)).body.error);
  assert.deepEqual(s.sent, [{ to: chatId, text: "Seni özledim" }]);
  const expired = (await s.tool("whatsapp_prepare_reply", { text: "old" })).body
    .result.structuredContent;
  s.advance(300001);
  assert.ok(
    (
      await s.tool("whatsapp_confirm_reply", {
        confirmation_id: expired.confirmation_id,
        approved_text: "old",
      })
    ).body.error,
  );
});

test("ambiguous send outcomes are durably consumed, preventing duplicate delivery", async (t) => {
  const s = await setup(t);
  s.ready();
  let calls = 0;
  s.client.sendMessage = async () => {
    calls++;
    throw new Error("timeout");
  };
  const p = (await s.tool("whatsapp_prepare_reply", { text: "Hello" })).body
    .result.structuredContent;
  const args = { confirmation_id: p.confirmation_id, approved_text: "Hello" };
  assert.match(
    (await s.tool("whatsapp_confirm_reply", args)).body.error.message,
    /unknown/u,
  );
  assert.ok((await s.tool("whatsapp_confirm_reply", args)).body.error);
  assert.equal(calls, 1);
  assert.equal(
    (await openStore(s.path, s.key)).read().confirmations[p.confirmation_id]
      .status,
    "sending",
  );
});

test("unsubscribe, expiry, retry backoff and terminal responses stop unwanted deliveries", async (t) => {
  let status = 503;
  const s = await setup(t, {
    sendCallback: async (_sub, payload) =>
      payload.type === "verification"
        ? {
            status: 200,
            body: JSON.stringify({ challenge: payload.challenge }),
          }
        : { status, body: "" },
  });
  s.ready();
  await s.rpc("events/subscribe", eventParams());
  await s.bridge.ingest(message("retry"));
  await s.bridge.pump();
  const id = s.store.read().outbox[0].event.eventId;
  assert.equal(s.store.read().outbox[0].attempts, 1);
  await s.bridge.pump();
  assert.equal(s.store.read().outbox[0].attempts, 1);
  s.advance(3000);
  status = 413;
  await s.bridge.pump();
  assert.equal(s.store.read().outbox[0].event.eventId, id);
  assert.equal(s.store.read().outbox[0].attempts, 8);
  const p = eventParams();
  delete p.delivery.secret;
  await s.rpc("events/unsubscribe", p);
  assert.equal(s.store.read().outbox.length, 0);
  assert.deepEqual((await s.rpc("events/unsubscribe", p)).body.result, {});
  await s.rpc("events/subscribe", eventParams());
  s.advance(86400001);
  await s.bridge.ingest(message("expired"));
  assert.equal(s.store.read().outbox.length, 0);
});

test("callbacks reject SSRF targets and signatures cover exact bytes", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  for (const url of [
    "http://callback.example/a",
    "https://evil.example/a",
    "https://user@callback.example/a",
    "https://callback.example:444/a",
  ])
    assert.throws(() => validateCallback(url, ["callback.example"]));
  const sender = createCallbackSender(["callback.example"], {
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    request: () => {
      throw new Error("Should not connect");
    },
  });
  await assert.rejects(
    sender(
      { url: "https://callback.example/a", secret, id: "sub" },
      { eventId: "evt" },
      "evt",
    ),
    /public/u,
  );
  const expected = createHmac("sha256", Buffer.alloc(32, 7))
    .update('evt.123.{"a":1}')
    .digest("base64");
  assert.equal(sign(secret, "evt", "123", '{"a":1}'), `v1,${expected}`);
});

test("HTTP boundary authenticates discovery, rejects malformed input and establishes a session", async (t) => {
  const s = await setup(t);
  const server = createHttpServer({ bridge: s.bridge, token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: "{" })).status,
    400,
  );
  const initialized = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session);
  const result = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal((await result.json()).result.tools.length, 4);
});

test("pending notifications and subscriptions survive restart without replaying outgoing messages", async (t) => {
  const s = await setup(t);
  s.ready();
  await s.rpc("events/subscribe", eventParams());
  await s.bridge.ingest(message("durable"));
  const restored = await openStore(s.path, s.key);
  const delivered = [];
  const client = new EventEmitter();
  const bridge = createBridge({
    client,
    store: restored,
    chatId,
    now: () => 1700000000000,
    sendCallback: async (_sub, payload) => {
      delivered.push(payload);
      return { status: 200, body: "" };
    },
  });
  await bridge.pump();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data.message_id, "durable");
  assert.equal(restored.read().outbox.length, 0);
  assert.equal(await bridge.ingest(message("durable")), false);
});

test("callback transport pins public DNS, preserves the signed bytes and does not follow redirects", async () => {
  let observed;
  let connections = 0;
  const sender = createCallbackSender(["callback.example"], {
    resolve: async (_host, options) => {
      assert.equal(options.family, 4);
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request: (url, options, onResponse) => {
      connections++;
      assert.equal(url.hostname, "callback.example");
      options.lookup("callback.example", { all: true }, (_error, addresses) =>
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]),
      );
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = (body) => {
        observed = { body, headers: options.headers };
        const res = new EventEmitter();
        res.statusCode = 302;
        onResponse(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.from("redirect ignored"));
          res.emit("end");
        });
      };
      return req;
    },
  });
  const payload = { eventId: "one", data: { text: "Здравей ❤️" } };
  const response = await sender(
    { id: "sub", secret, url: "https://callback.example/events" },
    payload,
    "one",
  );
  assert.equal(response.status, 302);
  assert.equal(connections, 1);
  assert.equal(observed.body, JSON.stringify(payload));
  assert.equal(
    observed.headers["webhook-signature"],
    sign(secret, "one", observed.headers["webhook-timestamp"], observed.body),
  );
  assert.equal(
    observed.headers["content-length"],
    Buffer.byteLength(observed.body),
  );
});
