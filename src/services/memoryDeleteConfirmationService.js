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
  "Потвърждавам изтриване от постоянната памет:";

const VALID_SCOPES = new Set(["personal", "project"]);

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

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
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
  return fingerprint(cleanOwnerId);
}

export function normalizeMemoryDeleteTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new MemoryDeleteConfirmationError(
      "Липсва точен запис за изтриване.",
      400,
      "MEMORY_DELETE_TARGET_INVALID",
    );
  }

  if (target.kind === "id") {
    const id = typeof target.id === "string" ? target.id.trim() : "";
    if (!id || id.length > 256) {
      throw new MemoryDeleteConfirmationError(
        "Липсва валиден идентификатор на записа.",
        400,
        "MEMORY_DELETE_TARGET_INVALID",
      );
    }
    return Object.freeze({ kind: "id", id });
  }

  if (target.kind === "fact") {
    const item = normalizeProfileMemoryDraft(
      target.fact,
      target.scope ?? "personal",
    );
    return Object.freeze({ kind: "fact", ...item });
  }

  if (target.kind === "all") {
    const scope = target.scope ?? null;
    if (scope !== null && !VALID_SCOPES.has(scope)) {
      throw new MemoryDeleteConfirmationError(
        "Невалиден обхват за изтриване.",
        400,
        "MEMORY_DELETE_TARGET_INVALID",
      );
    }
    return Object.freeze({ kind: "all", scope });
  }

  throw new MemoryDeleteConfirmationError(
    "Непознат вид изтриване.",
    400,
    "MEMORY_DELETE_TARGET_INVALID",
  );
}

function targetFingerprint(target) {
  return fingerprint(JSON.stringify(target));
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
    error?.message || "Потвърждението за изтриване е невалидно.",
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
  const normalizedTarget = normalizeMemoryDeleteTarget(target);
  let confirmation;
  try {
    confirmation = await createConfirmation({
      sessionId,
      action: MEMORY_DELETE_ACTION,
      resource: {
        ownerFingerprint: fingerprintOwner(ownerId),
        targetFingerprint: targetFingerprint(normalizedTarget),
        kind: normalizedTarget.kind,
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
      /^Потвърждавам изтриване от постоянната памет:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu,
    );
  return match?.[1] || null;
}

export function formatMemoryDeletePreparation(prepared) {
  const subject =
    prepared.target.kind === "fact"
      ? `точно този факт: ${prepared.target.fact}`
      : prepared.target.kind === "all" && prepared.target.scope
        ? `всички записи в обхват ${prepared.target.scope}`
        : prepared.target.kind === "all"
          ? "цялата постоянна памет"
          : "точно избрания запис";
  return [
    `Подготвих изтриване на ${subject}, но още не съм изтрил нищо.`,
    "Нужно е еднократно потвърждение.",
    "За изтриване изпрати точно:",
    `${MEMORY_DELETE_CONFIRM_PREFIX} ${prepared.confirmationId}`,
  ].join("\n");
}

export function formatMemoryDeleteResult(result) {
  if (result.target.kind === "fact") {
    return result.deleted
      ? `Забравих: ${result.target.fact}.`
      : "Не намерих такъв запис в постоянната памет.";
  }
  if (result.target.kind === "all") {
    return `Изтрих ${result.deleted} записа от постоянната памет.`;
  }
  return result.deleted
    ? "Изтрих точно избрания запис от постоянната памет."
    : "Записът вече не съществува в постоянната памет.";
}

export async function confirmMemoryDelete({
  confirmationId,
  sessionId,
  ownerId,
  expectedTarget,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  deleteById = deleteProfileMemory,
  deleteByFact = deleteProfileMemoryByFact,
  clearAll = clearProfileMemories,
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
  const target = normalizeMemoryDeleteTarget(confirmation.params?.target);
  const normalizedExpectedTarget = expectedTarget
    ? normalizeMemoryDeleteTarget(expectedTarget)
    : null;
  if (
    confirmation.resource?.ownerFingerprint !== fingerprintOwner(ownerId) ||
    confirmation.resource?.targetFingerprint !== targetFingerprint(target) ||
    confirmation.resource?.kind !== target.kind ||
    (normalizedExpectedTarget &&
      targetFingerprint(normalizedExpectedTarget) !== targetFingerprint(target))
  ) {
    throw new MemoryDeleteConfirmationError(
      "Профилът или записът не съответства на потвърденото изтриване.",
      403,
      "MEMORY_DELETE_TARGET_MISMATCH",
    );
  }

  await consumeConfirmation(confirmationId);
  let deleted;
  if (target.kind === "id") {
    deleted = (await deleteById(target.id, ownerId)) ? 1 : 0;
  } else if (target.kind === "fact") {
    deleted = await deleteByFact(target.fact, target.scope, ownerId);
  } else {
    deleted = await clearAll(target.scope ?? undefined, ownerId);
  }
  return Object.freeze({ target, deleted });
}
