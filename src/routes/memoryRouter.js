import express from "express";
import {
  clearProfileMemories,
  deleteProfileMemory,
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
  saveProfileMemory,
} from "../services/memoryService.js";
import { recordAuditEvent } from "../services/permissionService.js";
import { CANONICAL_PROJECT_MEMORY_ID } from "../config/projectIdentity.js";

const router = express.Router();

export const CLEAR_MEMORY_CONFIRMATION = "confirm-delete-profile-memory";

export function hasClearMemoryConfirmation(req) {
  return req.get("x-confirm-memory-delete") === CLEAR_MEMORY_CONFIRMATION;
}

async function auditMemoryAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    console.error("[Audit] Memory API write failure:", error);
  }
}

function sendMemoryError(res, error) {
  const status = error?.code === "INVALID_MEMORY" ? 400 : 503;
  console.error("[Memory]", error?.message || error);
  return res.status(status).json({
    error:
      status === 400
        ? error.message
        : "Постоянната памет временно не е достъпна.",
  });
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

router.post("/profile", async (req, res) => {
  try {
    const { fact, scope = "personal" } = req.body || {};
    if (typeof fact !== "string") {
      return res.status(400).json({ error: "Полето fact е задължително." });
    }
    const item = await saveProfileMemory(
      fact,
      "memory-api",
      scope,
      req.owner.memoryOwnerId,
    );
    await auditMemoryAction({
      action: "memory.write",
      decision: "allow",
      outcome: "succeeded",
      resource: "profile-memory",
      details: `api:${item.scope}:${item.id}`,
    });
    return res.status(201).json({ status: "ok", item });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.delete("/profile/:id", async (req, res) => {
  try {
    if (req.params.id === CANONICAL_PROJECT_MEMORY_ID) {
      return res.status(409).json({
        error:
          "Текущата основна формулировка се управлява от проекта и не е обикновен спомен.",
      });
    }
    if (!hasClearMemoryConfirmation(req)) {
      await auditMemoryAction({
        action: "memory.delete",
        decision: "confirm",
        outcome: "requested",
        resource: "profile-memory",
        details: `api:item:${req.params.id}`,
      });
      return res.status(409).json({
        error: "Изтриването изисква отделно точно потвърждение.",
        confirmationHeader: "x-confirm-memory-delete",
        confirmationValue: CLEAR_MEMORY_CONFIRMATION,
      });
    }
    const deleted = await deleteProfileMemory(
      req.params.id,
      req.owner.memoryOwnerId,
    );
    await auditMemoryAction({
      action: "memory.delete",
      decision: "confirmed",
      outcome: deleted ? "succeeded" : "not-found",
      resource: "profile-memory",
      details: `api:item:${req.params.id}`,
    });
    return res.json({ status: "ok", deleted });
  } catch (error) {
    if (error?.meta?.statusCode === 404) {
      return res.status(404).json({ error: "Записът не е намерен." });
    }
    return sendMemoryError(res, error);
  }
});

router.delete("/profile", async (req, res) => {
  try {
    if (!hasClearMemoryConfirmation(req)) {
      await auditMemoryAction({
        action: "memory.delete",
        decision: "confirm",
        outcome: "requested",
        resource: "profile-memory",
        details: "api:bulk",
      });
      return res.status(409).json({
        error: "Изтриването изисква отделно точно потвърждение.",
        confirmationHeader: "x-confirm-memory-delete",
        confirmationValue: CLEAR_MEMORY_CONFIRMATION,
      });
    }
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : undefined;
    const deleted = await clearProfileMemories(scope, req.owner.memoryOwnerId);
    await auditMemoryAction({
      action: "memory.delete",
      decision: "confirmed",
      outcome: "succeeded",
      resource: "profile-memory",
      details: `api:bulk:${scope || "all"}:${deleted}`,
    });
    return res.json({ status: "ok", deleted });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

export default router;
