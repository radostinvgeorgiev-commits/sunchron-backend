import { isAbsolute, join } from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import WhatsApp from "whatsapp-web.js";
import { openStore } from "./store.js";
import { createBridge } from "./bridge.js";
import { createCallbackSender } from "./callback.js";
import { createHttpServer } from "./http.js";

process.umask(0o077);
const { Client, LocalAuth } = WhatsApp;
const directory = process.env.WHATSAPP_STATE_DIRECTORY;
const secret = process.env.WHATSAPP_STATE_KEY || "";
const key = Buffer.from(secret, "base64");
const hosts = (process.env.WHATSAPP_CALLBACK_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const port = Number(process.env.WHATSAPP_BRIDGE_PORT || 8787);
if (!directory || !isAbsolute(directory))
  throw new Error("Set an absolute durable WHATSAPP_STATE_DIRECTORY");
if (key.length !== 32 || key.toString("base64") !== secret)
  throw new Error("Set WHATSAPP_STATE_KEY to a 32-byte base64 key");
if (
  !hosts.length ||
  hosts.some((host) => !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/u.test(host))
)
  throw new Error(
    "Configure exact WHATSAPP_CALLBACK_HOSTS; wildcards are forbidden",
  );
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid bridge port");
await mkdir(directory, { recursive: true, mode: 0o700 });
const lockPath = join(directory, "worker.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
const store = await openStore(join(directory, "bridge.enc"), key);
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "owner",
    dataPath: join(directory, "auth"),
  }),
  puppeteer: {
    headless: true,
    ...(process.env.WHATSAPP_CHROME_PATH
      ? { executablePath: process.env.WHATSAPP_CHROME_PATH }
      : {}),
  },
});
const bridge = createBridge({
  client,
  store,
  chatId: process.env.WHATSAPP_CHAT_ID,
  sendCallback: createCallbackSender(hosts),
});
const server = createHttpServer({
  bridge,
  token: process.env.WHATSAPP_BRIDGE_TOKEN,
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, "127.0.0.1");
const timer = setInterval(() => {
  bridge.pump().catch(() => {
    console.error("WhatsApp delivery worker failed; inspect protected status.");
  });
}, 1000);
timer.unref();
async function stop() {
  clearInterval(timer);
  server.close();
  await client.destroy().catch(() => {});
  await lock.close();
  await unlink(lockPath);
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
client.initialize().catch(() => {
  console.error(
    "WhatsApp initialization failed; no automatic re-pairing attempted.",
  );
});
