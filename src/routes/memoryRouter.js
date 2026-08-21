import express from "express";
import {
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
} from "../services/memoryService.js";
import {
  isAuditSafetyError,
  recordAuditEvent,
} from "../services/permissionService.js";
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
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";
import {
  buildKnowledgePreview,
  normalizeKnowledgeCandidates,
} from "../services/knowledgeIngestionService.js";
import {
  listApprovedKnowledge,
} from "../services/knowledgeService.js";
import {
  confirmKnowledgeImport,
  formatKnowledgeImportPreparation,
  KnowledgeImportConfirmationError,
  prepareKnowledgeImport,
} from "../services/knowledgeImportConfirmationService.js";

const router = express.Router();

async function auditMemoryAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    logSafeError("[Memory audit] Write failure", error);
  }
}

function sendMemoryError(res, error) {
  const status = error?.code === "INVALID_MEMORY" ? 400 : error?.status || 503;
  logSafeError("[Memory] Request failure", error);
  if (
    error instanceof MemoryWriteConfirmationError ||
    error instanceof MemoryDeleteConfirmationError ||
    error instanceof KnowledgeImportConfirmationError ||
    isAuditSafetyError(error)
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

function deleteRequestFields(req) {
  const body = req.body || {};
  return {
    sessionId: typeof body.sessionId === "string" ? body.sessionId.trim() : "",
    confirmationId:
      typeof body.confirmationId === "string" ? body.confirmationId.trim() : "",
  };
}

async function runProtectedMemoryDelete({
  req,
  res,
  target,
  prepare,
  confirm,
  audit,
}) {
  const { sessionId, confirmationId } = deleteRequestFields(req);
  if (!sessionId) {
    return res.status(400).json({
      error: "Полето sessionId е задължително за защитено изтриване.",
      code: "MISSING_SESSION",
    });
  }
  try {
    if (!confirmationId) {
      const prepared = await prepare({
        sessionId,
        ownerId: req.owner.memoryOwnerId,
        target,
      });
      await audit({
        action: "memory.delete",
        decision: "confirm",
        outcome: "requested",
        resource: "profile-memory",
        details: `api:${target.kind}:prepared`,
        sessionId,
      });
      return res.status(409).json({
        error: "Изтриването изисква еднократно точно потвърждение.",
        code: "MEMORY_DELETE_CONFIRMATION_REQUIRED",
        confirmationId: prepared.confirmationId,
        expiresAt: prepared.expiresAt,
        confirmationPhrase: formatMemoryDeletePreparation(prepared)
          .split("\n")
          .at(-1),
      });
    }

    const result = await confirm({
      confirmationId,
      sessionId,
      ownerId: req.owner.memoryOwnerId,
      expectedTarget: target,
    });
    return res.json({ status: "ok", deleted: result.deleted });
  } catch (error) {
    if (!isAuditSafetyError(error)) {
      await audit({
        action: "memory.delete",
        decision: confirmationId ? "confirmed" : "confirm",
        outcome: "failed",
        resource: "profile-memory",
        details: `api:${target.kind}:failed:${safeErrorCode(error, "MEMORY_DELETE_FAILED")}`,
        sessionId,
      });
    }
    return sendMemoryError(res, error);
  }
}

export function createProfileMemoryDeleteHandler({
  prepare = prepareMemoryDelete,
  confirm = confirmMemoryDelete,
  audit = auditMemoryAction,
} = {}) {
  return async function profileMemoryDeleteHandler(req, res) {
    if (req.params.id === CANONICAL_PROJECT_MEMORY_ID) {
      return res.status(409).json({
        error:
          "Текущата основна формулировка се управлява от проекта и не е обикновен спомен.",
      });
    }
    return runProtectedMemoryDelete({
      req,
      res,
      target: { kind: "id", id: req.params.id },
      prepare,
      confirm,
      audit,
    });
  };
}

export function createProfileMemoryClearHandler({
  prepare = prepareMemoryDelete,
  confirm = confirmMemoryDelete,
  audit = auditMemoryAction,
} = {}) {
  return async function profileMemoryClearHandler(req, res) {
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : undefined;
    return runProtectedMemoryDelete({
      req,
      res,
      target: { kind: "all", scope },
      prepare,
      confirm,
      audit,
    });
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
        replaceId:
          typeof body.memoryId === "string" ? body.memoryId.trim() : "",
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
      if (confirmationId && !isAuditSafetyError(error)) {
        await audit({
          action: "memory.write",
          decision: "confirmed",
          outcome: "failed",
          resource: "profile-memory",
          details: `api:failed:${safeErrorCode(error, "MEMORY_WRITE_FAILED")}`,
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

router.get("/knowledge", async (req, res) => {
  try {
    const scope = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const items = await listApprovedKnowledge({
      ownerId: req.owner.memoryOwnerId,
      scope,
    });
    return res.json({ status: "ok", items });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.post("/knowledge/preview", async (req, res) => {
  try {
    const preview = buildKnowledgePreview(
      req.body?.documents ?? req.body?.conversations ?? req.body,
      { scope: req.body?.scope },
    );
    await auditMemoryAction({
      action: "memory.read",
      decision: "allow",
      outcome: "preview",
      resource: "archive-knowledge",
      details: `preview:${preview.documentCount}:${preview.candidateCount}`,
      sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : "archive-preview",
    });
    return res.json({ status: "preview", ...preview });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.post("/knowledge/import", async (req, res) => {
  const body = req.body || {};
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const confirmationId = typeof body.confirmationId === "string" ? body.confirmationId.trim() : "";
  if (!sessionId) {
    return res.status(400).json({
      error: "Полето sessionId е задължително за архивен импорт.",
      code: "MISSING_SESSION",
    });
  }
  try {
    if (confirmationId) {
      const items = await confirmKnowledgeImport({
        confirmationId,
        sessionId,
        ownerId: req.owner.memoryOwnerId,
      });
      return res.status(201).json({ status: "ok", items });
    }
    const candidates = normalizeKnowledgeCandidates(body.items);
    const prepared = await prepareKnowledgeImport({
      sessionId,
      ownerId: req.owner.memoryOwnerId,
      items: candidates,
    });
    await auditMemoryAction({
      action: "memory.write",
      decision: "confirm",
      outcome: "requested",
      resource: "approved-knowledge",
      details: `archive-import-prepared:${prepared.items.length}`,
      sessionId,
    });
    return res.status(409).json({
      error: "Архивният импорт изисква еднократно точно потвърждение.",
      code: "KNOWLEDGE_IMPORT_CONFIRMATION_REQUIRED",
      confirmationId: prepared.confirmationId,
      expiresAt: prepared.expiresAt,
      items: prepared.items,
      confirmationPhrase: formatKnowledgeImportPreparation(prepared)
        .split("\n")
        .at(-1),
    });
  } catch (error) {
    if (!(error instanceof KnowledgeImportConfirmationError)) {
      await auditMemoryAction({
        action: "memory.write",
        decision: confirmationId ? "confirmed" : "confirm",
        outcome: "failed",
        resource: "approved-knowledge",
        details: `archive-import-failed:${safeErrorCode(error, "KNOWLEDGE_IMPORT_FAILED")}`,
        sessionId,
      });
    }
    return sendMemoryError(res, error);
  }
});

router.post("/profile", createProfileMemoryWriteHandler());

router.delete("/profile/:id", createProfileMemoryDeleteHandler());

router.delete("/profile", createProfileMemoryClearHandler());

export default router;
