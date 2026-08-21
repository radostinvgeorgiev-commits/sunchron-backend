import { createHash } from "node:crypto";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import { executeAuditedWriteAction } from "./permissionService.js";
import {
  normalizeKnowledgeCandidates,
} from "./knowledgeIngestionService.js";
import { saveApprovedKnowledgeItems } from "./knowledgeService.js";

export const KNOWLEDGE_IMPORT_ACTION = "memory.write:knowledge_import";

export class KnowledgeImportConfirmationError extends Error {
  constructor(message, status = 400, code = "KNOWLEDGE_IMPORT_CONFIRMATION_INVALID") {
    super(message);
    this.name = "KnowledgeImportConfirmationError";
    this.status = status;
    this.code = code;
  }
}

function fingerprintOwner(ownerId) {
  const clean = typeof ownerId === "string" ? ownerId.trim() : "";
  if (!clean) {
    throw new KnowledgeImportConfirmationError(
      "Липсва валиден собственик на знанието.",
      400,
      "KNOWLEDGE_OWNER_MISSING",
    );
  }
  return createHash("sha256").update(clean).digest("hex");
}

function mapConfirmationError(error) {
  if (error instanceof KnowledgeImportConfirmationError) return error;
  const statusByCode = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
  };
  return new KnowledgeImportConfirmationError(
    error?.message || "Потвърждението за импорт е невалидно.",
    statusByCode[error?.code] || 400,
    error?.code || "KNOWLEDGE_IMPORT_CONFIRMATION_INVALID",
  );
}

export async function prepareKnowledgeImport({
  sessionId,
  ownerId,
  items,
  createConfirmation = createDurableConfirmation,
} = {}) {
  const candidates = normalizeKnowledgeCandidates(items);
  let confirmation;
  try {
    confirmation = await createConfirmation({
      sessionId,
      action: KNOWLEDGE_IMPORT_ACTION,
      resource: {
        ownerFingerprint: fingerprintOwner(ownerId),
        itemCount: candidates.length,
      },
      params: { items: candidates },
    });
  } catch (error) {
    throw mapConfirmationError(error);
  }
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    items: candidates,
  });
}

export function formatKnowledgeImportPreparation(prepared) {
  return [
    "Подготвих архивния импорт, но още нищо не е записано.",
    `Кандидати: ${prepared.items.length}.`,
    "Класификацията е предварителна и трябва да бъде прегледана.",
    "За запис изпрати точно:",
    `Потвърждавам импорт на архивно знание: ${prepared.confirmationId}`,
  ].join("\n");
}

export async function confirmKnowledgeImport({
  confirmationId,
  sessionId,
  ownerId,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  saveKnowledge = saveApprovedKnowledgeItems,
  executeWrite = executeAuditedWriteAction,
} = {}) {
  let confirmation;
  try {
    confirmation = await validateConfirmation(confirmationId, sessionId);
  } catch (error) {
    throw mapConfirmationError(error);
  }
  if (confirmation.action !== KNOWLEDGE_IMPORT_ACTION) {
    throw new KnowledgeImportConfirmationError(
      "Потвърждението не е за архивен импорт.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== fingerprintOwner(ownerId)) {
    throw new KnowledgeImportConfirmationError(
      "Профилът не съответства на потвърдения импорт.",
      403,
      "KNOWLEDGE_OWNER_MISMATCH",
    );
  }
  const candidates = normalizeKnowledgeCandidates(confirmation.params?.items);
  if (confirmation.resource?.itemCount !== candidates.length) {
    throw new KnowledgeImportConfirmationError(
      "Съдържанието на потвърждението е променено.",
      400,
      "KNOWLEDGE_IMPORT_CONTENT_MISMATCH",
    );
  }

  await consumeConfirmation(confirmationId);
  return executeWrite({
    action: "memory.write",
    capability: KNOWLEDGE_IMPORT_ACTION,
    actor: "synchron-x-knowledge-import",
    sessionId,
    confirmationId,
    resource: "approved-knowledge",
    details: `archive-import:${candidates.length}`,
    execute: () => saveKnowledge({
      ownerId,
      items: candidates,
      source: "archive-import-approved",
    }),
  });
}
