import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getConversationPersistenceMetadata } from "../src/routes/chat.js";

test("conversation persistence metadata distinguishes saved and unsaved answers", () => {
  assert.deepEqual(getConversationPersistenceMetadata(true), {
    conversationPersisted: true,
  });
  assert.deepEqual(getConversationPersistenceMetadata(false), {
    conversationPersisted: false,
    warningCode: "CONVERSATION_NOT_SAVED",
  });
});

test("every successful conversation save path forwards the real persistence result", async () => {
  const source = await readFile(
    new URL("../src/routes/chat.js", import.meta.url),
    "utf8",
  );
  const saveCalls = source.match(
    /const conversationPersisted = await saveConversationTurnBestEffort\(/gu,
  );
  const metadataCalls = source.match(
    /\.\.\.getConversationPersistenceMetadata\(conversationPersisted\)/gu,
  );

  assert.equal(saveCalls?.length, 10);
  assert.equal(metadataCalls?.length, saveCalls?.length);
});
