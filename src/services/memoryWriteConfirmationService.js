import { createHash } from "node:crypto";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  normalizeProfileMemoryDraft,
  saveProfileMemory,
  updateProfileMemoryById,
} from "./memoryService.js";
import { executeAuditedWriteAction } from "./permissionService.js";
import { loadWorkspaceState } from "./workspaceStateService.js";

export const MEMORY_WRITE_ACTION = "memory.write:save_profile";
export const MEMORY_UPDATE_ACTION = "memory.write:update_profile";
export const MEMORY_WRITE_CONFIRM_PREFIX = "Потвърждавам постоянен запис:";

export class MemoryWriteConfirmationError extends Error {
  constructor(message, status = 400, code = "MEMORY_CONFIRMATION_INVALID") {
    super(message);
    this.name = "MemoryWriteConfirmationError";
    this.status = status;
    this.code = code;
  }
}

function fingerprintOwner(ownerId) {
  const cleanOwnerId = typeof ownerId === "string" ? ownerId.trim() : "";
  if (!cleanOwnerId) {
    throw new MemoryWriteConfirmationError(
      "Липсва валиден собственик на паметта.",
      400,
      "MEMORY_OWNER_MISSING",
    );
  }
  return createHash("sha256").update(cleanOwnerId).digest("hex");
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    throw new MemoryWriteConfirmationError(
      "Нужен е между един и 30 точни факта за запис.",
      400,
      "MEMORY_ITEMS_INVALID",
    );
  }
  return items.map(({ fact, scope = "personal" }) =>
    normalizeProfileMemoryDraft(fact, scope),
  );
}

function confirmationError(error) {
  if (error instanceof MemoryWriteConfirmationError) return error;
  const statusByCode = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
  };
  return new MemoryWriteConfirmationError(
    error?.message || "Потвърждението е невалидно.",
    statusByCode[error?.code] || 400,
    error?.code || "MEMORY_CONFIRMATION_INVALID",
  );
}

async function assertMemoryWriteAllowed(
  ownerId,
  loadWorkspace = loadWorkspaceState,
  env = process.env,
) {
  try {
    const workspace = await loadWorkspace(ownerId);
    if (workspace?.state?.preferences?.memoryMode === "disabled") {
      throw new MemoryWriteConfirmationError(
        "Записът в постоянната памет е изключен от собственика.",
        403,
        "MEMORY_WRITE_DISABLED",
      );
    }
  } catch (error) {
    if (error instanceof MemoryWriteConfirmationError) throw error;
    if (env.NODE_ENV === "production") {
      throw new MemoryWriteConfirmationError(
        "Настройката за паметта не може да бъде проверена.",
        503,
        "MEMORY_POLICY_UNAVAILABLE",
      );
    }
  }
}

export async function prepareMemoryWrite({
  sessionId,
  ownerId,
  items,
  replaceId,
  createConfirmation = createDurableConfirmation,
  loadWorkspace = loadWorkspaceState,
  env = process.env,
}) {
  await assertMemoryWriteAllowed(ownerId, loadWorkspace, env);
  const normalizedItems = normalizeItems(items);
  const cleanReplaceId =
    typeof replaceId === "string" ? replaceId.trim().slice(0, 200) : "";
  if (cleanReplaceId && normalizedItems.length !== 1) {
    throw new MemoryWriteConfirmationError(
      "Редактирането изисква точно един спомен.",
      400,
      "MEMORY_UPDATE_ITEMS_INVALID",
    );
  }
  let confirmation;
  try {
    confirmation = await createConfirmation({
      sessionId,
      action: cleanReplaceId ? MEMORY_UPDATE_ACTION : MEMORY_WRITE_ACTION,
      resource: {
        ownerFingerprint: fingerprintOwner(ownerId),
        itemCount: normalizedItems.length,
        ...(cleanReplaceId ? { replaceId: cleanReplaceId } : {}),
      },
      params: { items: normalizedItems },
    });
  } catch (error) {
    throw confirmationError(error);
  }
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    action: cleanReplaceId ? MEMORY_UPDATE_ACTION : MEMORY_WRITE_ACTION,
    items: normalizedItems,
  });
}

export function extractMemoryWriteConfirmationId(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^Потвърждавам постоянен запис:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu,
    );
  return match?.[1] || null;
}

export function formatMemoryWritePreparation(prepared) {
  const facts = prepared.items.map(({ fact }) => `• ${fact}`);
  return [
    "Подготвих постоянния запис, но още не съм записал нищо.",
    "Нужно е еднократно потвърждение.",
    "Точно съдържание:",
    ...facts,
    "За запис изпрати точно:",
    `${MEMORY_WRITE_CONFIRM_PREFIX} ${prepared.confirmationId}`,
  ].join("\n");
}

export function formatMemoryWriteResult(items) {
  if (items.length === 1) {
    return items[0].replaced
      ? `Обнових постоянната памет: ${items[0].fact}.`
      : `Запомних: ${items[0].fact}.`;
  }
  const replaced = items.filter((item) => item.replaced).length;
  return [
    `Записах ${items.length} факта в постоянната памет${
      replaced ? `, от които ${replaced} обновени` : ""
    }:`,
    ...items.map(({ fact }) => `• ${fact}`),
  ].join("\n");
}

export async function confirmMemoryWrite({
  confirmationId,
  sessionId,
  ownerId,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  saveMemory = saveProfileMemory,
  updateMemory = updateProfileMemoryById,
  executeWrite = executeAuditedWriteAction,
  source = "confirmed-memory-write",
  loadWorkspace = loadWorkspaceState,
  env = process.env,
}) {
  let confirmation;
  try {
    confirmation = await validateConfirmation(confirmationId, sessionId);
  } catch (error) {
    throw confirmationError(error);
  }
  if (
    confirmation.action !== MEMORY_WRITE_ACTION &&
    confirmation.action !== MEMORY_UPDATE_ACTION
  ) {
    throw new MemoryWriteConfirmationError(
      "Потвърждението не е за запис в паметта.",
      400,
      "CONFIRMATION_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== fingerprintOwner(ownerId)) {
    throw new MemoryWriteConfirmationError(
      "Профилът не съответства на потвърдения запис.",
      403,
      "MEMORY_OWNER_MISMATCH",
    );
  }
  const items = normalizeItems(confirmation.params?.items);
  if (confirmation.resource?.itemCount !== items.length) {
    throw new MemoryWriteConfirmationError(
      "Съдържанието на потвърждението е невалидно.",
      400,
      "MEMORY_CONFIRMATION_CONTENT_MISMATCH",
    );
  }

  await assertMemoryWriteAllowed(ownerId, loadWorkspace, env);

  await consumeConfirmation(confirmationId);
  return executeWrite({
    action: "memory.write",
    capability: confirmation.action,
    actor: "synchron-x-memory",
    sessionId,
    confirmationId,
    resource: "profile-memory",
    details:
      confirmation.action === MEMORY_UPDATE_ACTION
        ? "confirmed-memory-update"
        : `confirmed-items:${items.length}`,
    execute: async () => {
      if (confirmation.action === MEMORY_UPDATE_ACTION) {
        const saved = await updateMemory(
          confirmation.resource.replaceId,
          items[0].fact,
          items[0].scope,
          ownerId,
        );
        return Object.freeze([
          {
            id: saved.id,
            fact: saved.fact,
            scope: saved.scope,
            replaced: true,
          },
        ]);
      }
      const savedItems = [];
      for (const item of items) {
        const saved = await saveMemory(item.fact, source, item.scope, ownerId);
        savedItems.push({
          id: saved.id,
          fact: saved.fact,
          scope: saved.scope,
          replaced: Boolean(saved.replaced),
        });
      }
      return Object.freeze(savedItems);
    },
  });
}
