import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmGoogleAction,
  GOOGLE_CONFIRMED_ACTIONS,
  prepareGmailDraftSend,
  prepareGmailMessageSend,
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

test("a contact change may leave the name out but must change something", async () => {
  let confirmation;
  const createConfirmation = async (input) => {
    confirmation = { id: "confirmation-4", expiresAt: Date.now() + 60_000, ...input };
    return confirmation;
  };
  const base = { ownerId: "primary-user", googleSessionId: "google-session-1", sessionId: "session-1" };
  // A contact found without a name gets just a new phone.
  const prepared = await prepareGoogleContactChange(
    {
      ...base,
      operation: "update",
      contact: { resourceName: "people/p1", etag: "etag-1", name: "", phone: "+359 88 123 4567" },
    },
    { createConfirmation },
  );
  assert.equal(prepared.contact.name, "");
  assert.equal(confirmation.action, GOOGLE_CONFIRMED_ACTIONS.UPDATE_CONTACT);

  let written;
  await confirmGoogleAction(
    { ...base, confirmationId: "confirmation-4" },
    {
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => {},
      executeWrite: async ({ execute }) => execute(),
      updateContact: async (_session, draft) => {
        written = draft;
        return { resourceName: "people/p1", name: "", phone: draft.phone };
      },
    },
  );
  assert.equal(written.name, "");
  assert.equal(written.phone, "+359 88 123 4567");
  assert.equal(written.etag, "etag-1");

  // A change with nothing to change, and a new contact without a name, are refused.
  await assert.rejects(
    () =>
      prepareGoogleContactChange(
        { ...base, operation: "update", contact: { resourceName: "people/p1", etag: "etag-1" } },
        { createConfirmation },
      ),
    (error) => error.code === "GOOGLE_CONTACT_INVALID",
  );
  await assert.rejects(
    () =>
      prepareGoogleContactChange(
        { ...base, operation: "create", contact: { email: "client@example.com" } },
        { createConfirmation },
      ),
    (error) => error.code === "GOOGLE_ACTION_FIELD_INVALID",
  );
});

test("a new email is prepared, then sent only after the bound confirmation", async () => {
  let confirmation;
  const sent = [];
  const prepared = await prepareGmailMessageSend(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      to: "ana@example.com",
      subject: "Среща",
      body: "Здравей, Ана!",
    },
    {
      createConfirmation: async (input) => {
        confirmation = { id: "confirmation-3", ...input };
        return confirmation;
      },
    },
  );
  assert.equal(sent.length, 0);
  assert.equal(confirmation.action, GOOGLE_CONFIRMED_ACTIONS.SEND_MESSAGE);
  assert.equal(prepared.message.to, "ana@example.com");

  const order = [];
  const result = await confirmGoogleAction(
    {
      ownerId: "primary-user",
      googleSessionId: "google-session-1",
      sessionId: "session-1",
      confirmationId: "confirmation-3",
    },
    {
      validateConfirmation: async () => confirmation,
      consumeConfirmation: async () => order.push("consume"),
      executeWrite: async ({ execute, action }) => {
        order.push(`audit:${action}`);
        return execute();
      },
      sendMessage: async (googleSessionId, message) => {
        order.push("send");
        assert.equal(googleSessionId, "google-session-1");
        sent.push(message);
        return { id: "sent-1", to: message.to };
      },
    },
  );
  assert.deepEqual(order, ["consume", "audit:mail.send", "send"]);
  assert.equal(sent[0].body, "Здравей, Ана!");
  assert.equal(result.to, "ana@example.com");

  await assert.rejects(
    prepareGmailMessageSend(
      { ownerId: "o", googleSessionId: "g", sessionId: "s", to: "not-an-email", body: "x" },
      { createConfirmation: async () => assert.fail("must not prepare") },
    ),
  );
});
