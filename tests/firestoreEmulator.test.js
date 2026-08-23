import assert from "node:assert/strict";
import { Firestore } from "@google-cloud/firestore";
import test from "node:test";

import { resolveFirestoreConfig } from "../src/config/firestore.js";
import { createFirestoreMemoryAdapter } from "../src/services/firestoreMemoryAdapter.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

(emulatorHost ? test : test.skip)(
  "Firestore adapter passes the opt-in emulator contract without production credentials",
  async () => {
    const config = resolveFirestoreConfig({
      FIRESTORE_ENABLED: "true",
      GCP_PROJECT_ID: "synchron-emulator-test",
      FIRESTORE_DATABASE_ID: "(default)",
      FIRESTORE_LOCATION: "europe-west1",
      FIRESTORE_COLLECTION_PREFIX: `synchron-emulator-${Date.now()}-`,
      FIRESTORE_EMULATOR_HOST: emulatorHost,
      NODE_ENV: "test",
    });
    const client = new Firestore({
      projectId: config.projectId,
      databaseId: config.databaseId,
    });
    const adapter = createFirestoreMemoryAdapter({
      client,
      config,
      timeoutMs: 2_000,
    });

    try {
      await adapter.upsertProfileMemory({
        ownerId: "emulator-owner-a",
        memory: {
          id: "profile-emulator-a",
          fact: "Емулаторен факт",
          normalizedFact: "емулаторен факт",
          memoryKey: "personal:fact:emulator",
          category: "personal-fact",
          scope: "personal",
          source: "emulator-test",
        },
      });
      await adapter.saveConversationTurn({
        ownerId: "emulator-owner-a",
        sessionId: "emulator-session",
        userText: "Въпрос от емулатора",
        replyText: "Отговор от емулатора",
        turnId: "emulator-turn",
      });

      assert.equal(
        (await adapter.listProfileMemories({ ownerId: "emulator-owner-a" }))
          .length,
        1,
      );
      assert.deepEqual(
        (
          await adapter.listConversationMessages({
            ownerId: "emulator-owner-a",
            sessionId: "emulator-session",
          })
        ).map(({ role }) => role),
        ["user", "assistant"],
      );
      assert.equal(
        (await adapter.listProfileMemories({ ownerId: "emulator-owner-b" }))
          .length,
        0,
      );
    } finally {
      await client.terminate();
    }
  },
);
