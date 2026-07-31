import express from "express";
import {
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
} from "../services/memoryService.js";
import { recordAuditEvent } from "../services/permissionService.js";
import { CANONICAL_PROJECT_MEMORY_ID } from "../config/projectIdentity.js";
import {
  confirmMemoryWrite,
  formatMemoryWritePreparation,
  MemoryWriteConfirmationError,
  prepareMemoryWrite,
} from "../services/memoryWriteConfirmationService.js";
import {
  confirmMemoryDelete,
  formatMemoryDeletePreparation,
  MemoryDeleteConfirmationError,
  prepareMemoryDelete,
} from "../services/memoryDeleteConfirmationService.js";

const router = express.Router();

async function auditMemoryAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    console.error("[Audit] Memory API event failure:", error);
  }
}

function sendMemoryError(res, error) {
  const status = error?.code === "INVALID_MEMORY" ? 400 : error?.status || 503;
  console.error("[Memory]", error?.message || error);
  if (
    error instanceof MemoryWriteConfirmationError ||
    error instanceof MemoryDeleteConfirmationError
  ) {
    return res.status(status).json({
      error: error.message,
      code: error.code,
    });
  }
  return res.status(status).json({
    error:
      status === 400
        ? error.message
        : "Постоянната памет временно не е достъпна.",
  });
}

export function createProfileMemoryDeleteHandler({
  resolveTarget,
  prepare = prepareMemoryDelete,
  confirm = confirmMemoryDelete,
  audit = auditMemoryAction,
} = {}) {
  if (typeof resolveTarget !== "function") {
    throw new TypeError("resolveTarget е задължителен за memory delete route.");
  }
  return async function profileMemoryDeleteHandler(req, res) {
    const body = req.body || {};
    const sessionId =
      (typeof body.sessionId === "string" && body.sessionId.trim()) ||
      (typeof req.get("x-memory-session-id") === "string" &&
        req.get("x-memory-session-id").trim()) ||
      "";
    const confirmationId =
      typeof req.get("x-confirm-memory-delete") === "string"
        ? req.get("x-confirm-memory-delete").trim()
        : "";
    if (!sessionId) {
      return res.status(400).json({
        error: "Липсва валидна сесия за защитено изтриване.",
        code: "MISSING_SESSION",
      });
    }

    try {
      if (confirmationId) {
        const result = await confirm({
          confirmationId,
          sessionId,
          ownerId: req.owner.memoryOwnerId,
          expectedTarget: resolveTarget(req),
        });
        await audit({
          action: "memory.delete",
          decision: "confirmed",
          outcome: "succeeded",
          resource: "profile-memory",
          details: `api:confirmed:${result.target.kind}:${result.deleted}`,
          sessionId,
        });
        return res.json({ status: "ok", ...result });
      }

      const prepared = await prepare({
        sessionId,
        ownerId: req.owner.memoryOwnerId,
        target: resolveTarget(req),
      });
      await audit({
        action: "memory.delete",
        decision: "confirm",
        outcome: "requested",
        resource: "profile-memory",
        details: `api:prepared:${prepared.target.kind}`,
        sessionId,
      });
      return res.status(409).json({
        error: "Изтриването изисква отделно еднократно потвърждение.",
        code: "MEMORY_DELETE_CONFIRMATION_REQUIRED",
        confirmationId: prepared.confirmationId,
        expiresAt: prepared.expiresAt,
        target: prepared.target,
        confirmationPhrase: formatMemoryDeletePreparation(prepared)
          .split("\n")
          .at(-1),
      });
    } catch (error) {
      if (confirmationId) {
        await audit({
          action: "memory.delete",
          decision: "confirmed",
          outcome: "failed",
          resource: "profile-memory",
          details: `api:failed:${error?.code || "unknown"}`,
          sessionId,
        });
      }
      return sendMemoryError(res, error);
    }
  };
}

export function createProfileMemoryWriteHandler({
  prepare = prepareMemoryWrite,
  confirm = confirmMemoryWrite,
  audit = auditMemoryAction,
} = {}) {
  return async function profileMemoryWriteHandler(req, res) {
    const body = req.body || {};
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const confirmationId =
      typeof body.confirmationId === "string" ? body.confirmationId.trim() : "";
    if (!sessionId) {
      return res.status(400).json({
        error: "Полето sessionId е задължително за защитен запис.",
        code: "MISSING_SESSION",
      });
    }

    try {
      if (confirmationId) {
        const items = await confirm({
          confirmationId,
          sessionId,
          ownerId: req.owner.memoryOwnerId,
          source: "confirmed-memory-api",
        });
        await audit({
          action: "memory.write",
          decision: "confirmed",
          outcome: "succeeded",
          resource: "profile-memory",
          details: `api:confirmed:${items.length}:${[
            ...new Set(items.map(({ scope }) => scope)),
          ].join(",")}`,
          sessionId,
        });
        return res.status(201).json({ status: "ok", items });
      }

      if (typeof body.fact !== "string") {
        return res.status(400).json({
          error: "Полето fact е задължително.",
          code: "INVALID_MEMORY",
        });
      }
      const prepared = await prepare({
        sessionId,
        ownerId: req.owner.memoryOwnerId,
        items: [{ fact: body.fact, scope: body.scope ?? "personal" }],
      });
      await audit({
        action: "memory.write",
        decision: "confirm",
        outcome: "requested",
        resource: "profile-memory",
        details: `api:prepared:${prepared.items.length}`,
        sessionId,
      });
      return res.status(409).json({
        error: "Записът в постоянната памет изисква точно потвърждение.",
        code: "MEMORY_WRITE_CONFIRMATION_REQUIRED",
        confirmationId: prepared.confirmationId,
        expiresAt: prepared.expiresAt,
        items: prepared.items,
        confirmationPhrase: formatMemoryWritePreparation(prepared)
          .split("\n")
          .at(-1),
      });
    } catch (error) {
      if (confirmationId) {
        await audit({
          action: "memory.write",
          decision: "confirmed",
          outcome: "failed",
          resource: "profile-memory",
          details: `api:failed:${error?.code || "unknown"}`,
          sessionId,
        });
      }
      return sendMemoryError(res, error);
    }
  };
}

router.get("/conversations", async (req, res) => {
  try {
    const items = await listConversationSummaries(
      undefined,
      req.owner.memoryOwnerId,
    );
    return res.json({ status: "ok", items });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.get("/conversation/:sessionId", async (req, res) => {
  try {
    const items = await listConversationMessages(
      req.params.sessionId,
      undefined,
      req.owner.memoryOwnerId,
    );
    return res.json({ status: "ok", items });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.get("/profile", async (req, res) => {
  try {
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : undefined;
    const items = await listProfileMemories({
      scope,
      ownerId: req.owner.memoryOwnerId,
    });
    return res.json({ status: "ok", items });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.post("/profile", createProfileMemoryWriteHandler());

const deleteOneProfileMemory = createProfileMemoryDeleteHandler({
  resolveTarget(req) {
    return { kind: "id", id: req.params.id };
  },
});

router.delete("/profile/:id", (req, res, next) => {
  if (req.params.id === CANONICAL_PROJECT_MEMORY_ID) {
    return res.status(409).json({
      error:
        "Текущата основна формулировка се управлява от проекта и не е обикновен спомен.",
    });
  }
  return deleteOneProfileMemory(req, res, next);
});

router.delete(
  "/profile",
  createProfileMemoryDeleteHandler({
    resolveTarget(req) {
      const scope =
        typeof req.query.scope === "string" ? req.query.scope : null;
      return { kind: "all", scope };
    },
  }),
);

export default router;
