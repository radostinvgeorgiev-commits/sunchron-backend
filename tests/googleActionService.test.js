import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmGoogleAction,
  GOOGLE_CONFIRMED_ACTIONS,
  prepareGmailDraftSend,
  prepareGmailMessageTrash,
  prepareGoogleContactChange,
} from "../src/services/googleActionService.js";

test("prepares an exact Gmail draft send without sending", async () => {
  let confirmation;
  let sent = false;
  const prepared = await prepareGmailDraftSend(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      draftId: "draft-1",
    },
    {
      getDraft: async () => ({
        id: "draft-1",
        messageId: "message-1",
        to: "client@example.com",
        subject: "Преглед",
      }),
      createConfirmation: async (input) => {
        confirmation = {
          id: "confirmation-1",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return confirmation;
      },
      sendDraft: async () => {
        sent = true;
      },
    },
  );

  assert.equal(sent, false);
  assert.equal(confirmation.action, GOOGLE_CONFIRMED_ACTIONS.SEND_DRAFT);
  assert.equal(confirmation.resource.draftId, "draft-1");
  assert.doesNotMatch(
    JSON.stringify(confirmation),
    /primary-user|google-session-1/u,
  );
  assert.equal(prepared.draft.to, "client@example.com");
});

test("confirms only the owner- and Google-session-bound action", async () => {
  let confirmation;
  await prepareGmailMessageTrash(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      messageId: "message-1",
    },
    {
      getMessage: async () => ({
        id: "message-1",
        from: "sender@example.com",
        subject: "Старо",
      }),
      createConfirmation: async (input) => {
        confirmation = { id: "confirmation-2", ...input };
        return confirmation;
      },
    },
  );
  const order = [];
  const result = await confirmGoogleAction(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      confirmationId: "confirmation-2",
    },
    {
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => order.push("consume"),
      executeWrite: async ({ execute, action }) => {
        order.push(`audit:${action}`);
        return execute();
      },
      trashMessage: async (googleSessionId, messageId) => {
        order.push("trash");
        assert.equal(googleSessionId, "google-session-1");
        assert.equal(messageId, "message-1");
        return { id: messageId, trashed: true };
      },
    },
  );

  assert.deepEqual(order, ["consume", "audit:mail.delete", "trash"]);
  assert.equal(result.trashed, true);
});

test("contact changes require an exact confirmation and reject session substitution", async () => {
  let confirmation;
  const prepared = await prepareGoogleContactChange(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      operation: "create",
      contact: {
        name: "Клиент",
        email: "client@example.com",
      },
    },
    {
      createConfirmation: async (input) => {
        confirmation = {
          id: "confirmation-3",
          expiresAt: Date.now() + 60_000,
          ...input,
        };
        return confirmation;
      },
    },
  );
  assert.equal(prepared.operation, "create");
  assert.equal(confirmation.action, GOOGLE_CONFIRMED_ACTIONS.CREATE_CONTACT);

  let consumed = false;
  await assert.rejects(
    () =>
      confirmGoogleAction(
        {
          ownerId: "primary-user",
          googleSessionId: "google-session-2",
          sessionId: "session-1",
          confirmationId: "confirmation-3",
        },
        {
          validateConfirmation: async () => confirmation,
          consumeConfirmation: async () => {
            consumed = true;
          },
        },
      ),
    (error) => error.code === "GOOGLE_ACTION_SESSION_MISMATCH",
  );
  assert.equal(consumed, false);
});
