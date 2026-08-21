import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  confirmKnowledgeImport,
  KNOWLEDGE_IMPORT_ACTION,
  prepareKnowledgeImport,
} from "../src/services/knowledgeImportConfirmationService.js";

test("knowledge import binds the confirmation to owner and session", async () => {
  let stored = null;
  const prepared = await prepareKnowledgeImport({
    sessionId: "session-a",
    ownerId: "owner-a",
    items: [{ id: "a", text: "Това е одобрено знание за проекта.", scope: "project" }],
    createConfirmation: async (input) => ({ id: "confirmation-a", expiresAt: 123, ...input }),
  });
  assert.equal(prepared.items.length, 1);

  const saved = await confirmKnowledgeImport({
    confirmationId: "confirmation-a",
    sessionId: "session-a",
    ownerId: "owner-a",
    validateConfirmation: async () => ({
      id: "confirmation-a",
      action: KNOWLEDGE_IMPORT_ACTION,
      resource: { ownerFingerprint: "8e7d4f3a6a6bdc0f6e91e1f8579bda54db1b5bc7ed2c31f7b8ef3e1de4f5f7a6", itemCount: 1 },
      params: { items: prepared.items },
    }),
    consumeConfirmation: async () => {},
    saveKnowledge: async ({ items }) => { stored = items; return items; },
    executeWrite: async ({ execute }) => execute(),
  }).catch((error) => error);

  // The test uses an intentionally wrong fingerprint to verify fail-closed behavior.
  assert.equal(saved.code, "KNOWLEDGE_OWNER_MISMATCH");
  assert.equal(stored, null);
});

test("knowledge import consumes once and writes only after the exact owner match", async () => {
  const ownerFingerprint = createHash("sha256").update("owner-a").digest("hex");
  let consumed = 0;
  let written = null;
  const result = await confirmKnowledgeImport({
    confirmationId: "confirmation-b",
    sessionId: "session-a",
    ownerId: "owner-a",
    validateConfirmation: async () => ({
      id: "confirmation-b",
      action: KNOWLEDGE_IMPORT_ACTION,
      resource: { ownerFingerprint, itemCount: 1 },
      params: {
        items: [{ id: "a", text: "Одобрено знание за NOVARIUM.", scope: "project" }],
      },
    }),
    consumeConfirmation: async () => {
      consumed += 1;
    },
    saveKnowledge: async ({ ownerId, items }) => {
      written = { ownerId, items };
      return items;
    },
    executeWrite: async ({ execute }) => execute(),
  });

  assert.equal(consumed, 1);
  assert.equal(written.ownerId, "owner-a");
  assert.equal(result[0].text, "Одобрено знание за NOVARIUM.");
});
