import { createHash } from "node:crypto";

import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  createGoogleContact,
  getGmailDraft,
  getGmailMessage,
  sendGmailDraft,
  trashGmailMessage,
  updateGoogleContact,
} from "./googleDriveService.js";
import { executeAuditedWriteAction } from "./permissionService.js";

const ACTIONS = Object.freeze({
  SEND_DRAFT: "mail.send:draft",
  TRASH_MESSAGE: "mail.delete:message",
  CREATE_CONTACT: "contacts.write:create",
  UPDATE_CONTACT: "contacts.write:update",
});

export class GoogleActionError extends Error {
  constructor(message, status = 400, code = "GOOGLE_ACTION_INVALID") {
    super(message);
    this.name = "GoogleActionError";
    this.status = status;
    this.code = code;
  }
}

function cleanRequired(value, maxLength, label) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (
    !clean ||
    clean.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(clean)
  ) {
    throw new GoogleActionError(
      `Липсва валидно поле „${label}“.`,
      400,
      "GOOGLE_ACTION_FIELD_INVALID",
    );
  }
  return clean;
}

function fingerprint(label, value) {
  return createHash("sha256")
    .update(`${label}\0`)
    .update(cleanRequired(value, 400, label))
    .digest("hex");
}

function ownerFingerprint(ownerId) {
  return fingerprint("owner", ownerId);
}

function googleSessionFingerprint(googleSessionId) {
  return fingerprint("google-session", googleSessionId);
}

function confirmationError(error) {
  if (error instanceof GoogleActionError) return error;
  const statuses = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
  };
  return new GoogleActionError(
    error?.message || "Потвърждението не е валидно.",
    statuses[error?.code] || error?.status || 400,
    error?.code || "GOOGLE_ACTION_CONFIRMATION_INVALID",
  );
}

function contactDraft(input = {}) {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (
    email.length > 320 ||
    phone.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(email) ||
    /[\u0000-\u001f\u007f]/u.test(phone) ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) ||
    (!email && !phone)
  ) {
    throw new GoogleActionError(
      "Контактът трябва да има валиден имейл или телефон.",
      400,
      "GOOGLE_CONTACT_INVALID",
    );
  }
  return Object.freeze({
    name: cleanRequired(input.name, 300, "име"),
    email,
    phone,
    resourceName:
      typeof input.resourceName === "string"
        ? input.resourceName.trim().slice(0, 200)
        : "",
    etag: typeof input.etag === "string" ? input.etag.trim().slice(0, 200) : "",
  });
}

async function createBoundConfirmation({
  ownerId,
  googleSessionId,
  sessionId,
  action,
  resource,
  params = {},
  createConfirmation = createDurableConfirmation,
}) {
  try {
    return await createConfirmation({
      sessionId,
      action,
      resource: {
        ...resource,
        ownerFingerprint: ownerFingerprint(ownerId),
        googleSessionFingerprint: googleSessionFingerprint(googleSessionId),
      },
      params,
    });
  } catch (error) {
    throw confirmationError(error);
  }
}

export async function prepareGmailDraftSend(
  { ownerId, googleSessionId, sessionId, draftId } = {},
  { getDraft = getGmailDraft, createConfirmation } = {},
) {
  const draft = await getDraft(googleSessionId, draftId);
  const confirmation = await createBoundConfirmation({
    ownerId,
    googleSessionId,
    sessionId,
    action: ACTIONS.SEND_DRAFT,
    resource: {
      draftId: draft.id,
      messageId: draft.messageId,
      to: draft.to,
      subject: draft.subject,
    },
    createConfirmation,
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    draft,
  });
}

export async function prepareGmailMessageTrash(
  { ownerId, googleSessionId, sessionId, messageId } = {},
  { getMessage = getGmailMessage, createConfirmation } = {},
) {
  const message = await getMessage(googleSessionId, messageId);
  const confirmation = await createBoundConfirmation({
    ownerId,
    googleSessionId,
    sessionId,
    action: ACTIONS.TRASH_MESSAGE,
    resource: {
      messageId: message.id,
      from: message.from,
      subject: message.subject,
    },
    createConfirmation,
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    message,
  });
}

export async function prepareGoogleContactChange(
  { ownerId, googleSessionId, sessionId, operation = "create", contact } = {},
  { createConfirmation } = {},
) {
  const draft = contactDraft(contact);
  const action =
    operation === "create"
      ? ACTIONS.CREATE_CONTACT
      : operation === "update"
        ? ACTIONS.UPDATE_CONTACT
        : null;
  if (!action) {
    throw new GoogleActionError(
      "Неподдържана промяна на контакт.",
      400,
      "GOOGLE_CONTACT_OPERATION_INVALID",
    );
  }
  if (operation === "update" && (!draft.resourceName || !draft.etag)) {
    throw new GoogleActionError(
      "За промяна са нужни resourceName и etag на контакта.",
      400,
      "GOOGLE_CONTACT_VERSION_REQUIRED",
    );
  }
  const confirmation = await createBoundConfirmation({
    ownerId,
    googleSessionId,
    sessionId,
    action,
    resource: {
      operation,
      resourceName: draft.resourceName || "new-contact",
      name: draft.name,
      email: draft.email,
      phone: draft.phone,
    },
    params: { contact: draft },
    createConfirmation,
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    operation,
    contact: draft,
  });
}

export async function confirmGoogleAction(
  { ownerId, googleSessionId, sessionId, confirmationId } = {},
  {
    validateConfirmation = validateDurableConfirmation,
    consumeConfirmation = markDurableConfirmationUsed,
    executeWrite = executeAuditedWriteAction,
    sendDraft = sendGmailDraft,
    trashMessage = trashGmailMessage,
    createContact = createGoogleContact,
    updateContact = updateGoogleContact,
  } = {},
) {
  let confirmation;
  try {
    confirmation = await validateConfirmation(confirmationId, sessionId);
  } catch (error) {
    throw confirmationError(error);
  }
  if (!Object.values(ACTIONS).includes(confirmation.action)) {
    throw new GoogleActionError(
      "Потвърждението не е за Google действие.",
      400,
      "GOOGLE_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== ownerFingerprint(ownerId)) {
    throw new GoogleActionError(
      "Профилът не съответства на потвърденото действие.",
      403,
      "GOOGLE_ACTION_OWNER_MISMATCH",
    );
  }
  if (
    confirmation.resource?.googleSessionFingerprint !==
    googleSessionFingerprint(googleSessionId)
  ) {
    throw new GoogleActionError(
      "Google връзката не съответства на потвърденото действие.",
      403,
      "GOOGLE_ACTION_SESSION_MISMATCH",
    );
  }

  await consumeConfirmation(confirmationId);
  const action = confirmation.action;
  return executeWrite({
    action:
      action === ACTIONS.SEND_DRAFT
        ? "mail.send"
        : action === ACTIONS.TRASH_MESSAGE
          ? "mail.delete"
          : "contacts.write",
    capability: action,
    actor: "synchron-x-google",
    sessionId,
    confirmationId,
    resource:
      confirmation.resource.draftId ||
      confirmation.resource.messageId ||
      confirmation.resource.resourceName,
    details: action,
    execute: async () => {
      if (action === ACTIONS.SEND_DRAFT) {
        return sendDraft(googleSessionId, confirmation.resource.draftId);
      }
      if (action === ACTIONS.TRASH_MESSAGE) {
        return trashMessage(googleSessionId, confirmation.resource.messageId);
      }
      const draft = contactDraft(confirmation.params?.contact);
      return action === ACTIONS.CREATE_CONTACT
        ? createContact(googleSessionId, draft)
        : updateContact(googleSessionId, draft);
    },
  });
}

export const GOOGLE_CONFIRMED_ACTIONS = ACTIONS;
