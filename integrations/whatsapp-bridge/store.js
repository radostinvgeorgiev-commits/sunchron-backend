import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// One process owns this store. All state, including callback credentials, is
// encrypted. Never point this path at a shared directory with another worker.
export async function openStore(path, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new Error("Invalid state encryption key");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let state = {
    messages: [],
    subscriptions: {},
    outbox: [],
    confirmations: {},
  };
  try {
    const data = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    state = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot decrypt bridge state");
  }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    update(fn) {
      const task = queue.then(async () => {
        const next = structuredClone(state);
        const result = await fn(next);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(next)),
          cipher.final(),
        ]);
        await writeFile(
          `${path}.tmp`,
          Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
          { mode: 0o600 },
        );
        await rename(`${path}.tmp`, path);
        state = next;
        return result;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
