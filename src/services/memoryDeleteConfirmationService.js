import { createHash } from "node:crypto";

import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  clearProfileMemories,
  deleteProfileMemory,
  deleteProfileMemoryByFact,
  normalizeProfileMemoryDraft,
} from "./memoryService.js";

export const MEMORY_DELETE_ACTION = "memory.delete:profile";
export const MEMORY_DELETE_CONFIRM_PREFIX =
  "Потвърждавам изтриването от постоянната памет:";

export class MemoryDeleteConfirmationError extends Error {
  constructor(
    message,
    status = 400,
    code = "MEMORY_DELETE_CONFIRMATION_INVALID",
  ) {
    super(message);
    this.name = "MemoryDeleteConfirmationError";
    this.status = status;
    this.code = code;
  }
}

function fingerprintOwner(ownerId) {
  const cleanOwnerId = typeof ownerId === "string" ? ownerId.trim() : "";
  if (!cleanOwnerId) {
    throw new MemoryDeleteConfirmationError(
      "Липсва валиден собственик на паметта.",
      400,
      "MEMORY_OWNER_MISSING",
    );
  }
  return createHash("sha256").update(cleanOwnerId).digest("hex");
}

function normalizeScope(scope, { optional = false } = {}) {
  if (optional && (scope === undefined || scope === null || scope === "")) {
    return null;
  }
  if (scope !== "personal" && scope !== "project") {
    throw new MemoryDeleteConfirmationError(
      "Невалиден обхват на паметта.",
      400,
      "INVALID_MEMORY_SCOPE",
    );
  }
  return scope;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new MemoryDeleteConfirmationError(
      "Липсва точна цел за изтриване.",
      400,
      "MEMORY_DELETE_TARGET_MISSING",
    );
  }
  if (target.kind === "fact") {
    const item = normalizeProfileMemoryDraft(
      target.fact,
      target.scope || "personal",
    );
    return Object.freeze({ kind: "fact", fact: item.fact, scope: item.scope });
  }
  if (target.kind === "id") {
    const id = typeof target.id === "string" ? target.id.trim() : "";
    if (!id || id.length > 200) {
      throw new MemoryDeleteConfirmationError(
        "Липсва валиден идентификатор на записа.",
        400,
        "MEMORY_DELETE_ID_INVALID",
      );
    }
    return Object.freeze({ kind: "id", id });
  }
  if (target.kind === "all") {
    return Object.freeze({
      kind: "all",
      scope: normalizeScope(target.scope, { optional: true }),
    });
  }
  throw new MemoryDeleteConfirmationError(
    "Неподдържана цел за изтриване.",
    400,
    "MEMORY_DELETE_TARGET_INVALID",
  );
}

function confirmationError(error) {
  if (error instanceof MemoryDeleteConfirmationError) return error;
  const statusByCode = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
  };
  return new MemoryDeleteConfirmationError(
    error?.message || "Потвърждението е невалидно.",
    statusByCode[error?.code] || 400,
    error?.code || "MEMORY_DELETE_CONFIRMATION_INVALID",
  );
}

export async function prepareMemoryDelete({
  sessionId,
  ownerId,
  target,
  createConfirmation = createDurableConfirmation,
}) {
  const normalizedTarget = normalizeTarget(target);
  let confirmation;
  try {
    confirmation = await createConfirmation({
      sessionId,
      action: MEMORY_DELETE_ACTION,
      resource: {
        ownerFingerprint: fingerprintOwner(ownerId),
        targetKind: normalizedTarget.kind,
      },
      params: { target: normalizedTarget },
    });
  } catch (error) {
    throw confirmationError(error);
  }
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    target: normalizedTarget,
  });
}

export function extractMemoryDeleteConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^Потвърждавам изтриването от постоянната памет:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu,
    );
  return match?.[1] || null;
}

export function formatMemoryDeletePreparation(prepared) {
  const target = prepared.target;
  const description =
    target.kind === "fact"
      ? `Точен факт: ${target.fact}`
      : target.kind === "id"
        ? "Точно избраният запис."
        : target.scope
          ? `Всички записи в обхват „${target.scope}“.`
          : "Цялата постоянна профилна памет.";
  return [
    "Подготвих изтриването, но още не съм изтрил нищо.",
    description,
    "За изтриване изпрати точно:",
    `${MEMORY_DELETE_CONFIRM_PREFIX} ${prepared.confirmationId}`,
  ].join("\n");
}

export async function confirmMemoryDelete({
  confirmationId,
  sessionId,
  ownerId,
  expectedTarget,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  deleteByFact = deleteProfileMemoryByFact,
  deleteById = deleteProfileMemory,
  deleteAll = clearProfileMemories,
}) {
  let confirmation;
  try {
    confirmation = await validateConfirmation(confirmationId, sessionId);
  } catch (error) {
    throw confirmationError(error);
  }
  if (confirmation.action !== MEMORY_DELETE_ACTION) {
    throw new MemoryDeleteConfirmationError(
      "Потвърждението не е за изтриване от паметта.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== fingerprintOwner(ownerId)) {
    throw new MemoryDeleteConfirmationError(
      "Профилът не съответства на потвърденото изтриване.",
      403,
      "MEMORY_OWNER_MISMATCH",
    );
  }
  const target = normalizeTarget(confirmation.params?.target);
  if (confirmation.resource?.targetKind !== target.kind) {
    throw new MemoryDeleteConfirmationError(
      "Целта на потвърждението е невалидна.",
      400,
      "MEMORY_DELETE_TARGET_MISMATCH",
    );
  }
  if (
    expectedTarget &&
    JSON.stringify(normalizeTarget(expectedTarget)) !== JSON.stringify(target)
  ) {
    throw new MemoryDeleteConfirmationError(
      "Заявеното изтриване не съответства на потвърдената цел.",
      403,
      "MEMORY_DELETE_TARGET_MISMATCH",
    );
  }

  await consumeConfirmation(confirmationId);
  let deleted;
  if (target.kind === "fact") {
    deleted = await deleteByFact(target.fact, target.scope, ownerId);
  } else if (target.kind === "id") {
    deleted = await deleteById(target.id, ownerId);
  } else {
    deleted = await deleteAll(target.scope || undefined, ownerId);
  }
  return Object.freeze({ target, deleted });
}
