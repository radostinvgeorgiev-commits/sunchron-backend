import { isAbsolute, join } from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import WhatsApp from "whatsapp-web.js";

// Run interactively on the chosen private host, with its own display. Pairing
// takes place in WhatsApp's visible browser page, never via chat or logs.
process.umask(0o077);
const directory = process.env.WHATSAPP_STATE_DIRECTORY;
if (!directory || !isAbsolute(directory))
  throw new Error("Set an absolute durable WHATSAPP_STATE_DIRECTORY");
await mkdir(directory, { recursive: true, mode: 0o700 });
const lockPath = join(directory, "worker.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
const client = new WhatsApp.Client({
  authStrategy: new WhatsApp.LocalAuth({
    clientId: "owner",
    dataPath: join(directory, "auth"),
  }),
  puppeteer: {
    headless: false,
    ...(process.env.WHATSAPP_CHROME_PATH
      ? { executablePath: process.env.WHATSAPP_CHROME_PATH }
      : {}),
  },
});
client.on("ready", async () => {
  console.log(
    "WhatsApp paired. Close pairing with Ctrl+C before starting the worker.",
  );
  const exactName = process.env.WHATSAPP_CHAT_NAME;
  if (exactName) {
    // Local administrator terminal only; never executed in ChatGPT or logged
    // by the worker. Exact-name candidates still require human verification.
    const candidates = (await client.getChats()).filter(
      (chat) => !chat.isGroup && chat.name === exactName,
    );
    for (const chat of candidates)
      console.log(
        JSON.stringify({ name: chat.name, chat_id: chat.id._serialized }),
      );
  }
});
process.once("SIGINT", async () => {
  await client.destroy();
  await lock.close();
  await unlink(lockPath);
  process.exit(0);
});
await client.initialize();
