import express from "express";
import {
  clearProfileMemories,
  deleteProfileMemory,
  listConversationMessages,
  listProfileMemories,
  saveProfileMemory,
} from "../services/memoryService.js";

const router = express.Router();

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

router.get("/conversation/:sessionId", async (req, res) => {
  try {
    const items = await listConversationMessages(req.params.sessionId);
    return res.json({ status: "ok", items });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.get("/profile", async (req, res) => {
  try {
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : undefined;
    const items = await listProfileMemories({ scope });
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
    const item = await saveProfileMemory(fact, "memory-api", scope);
    return res.status(201).json({ status: "ok", item });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

router.delete("/profile/:id", async (req, res) => {
  try {
    const deleted = await deleteProfileMemory(req.params.id);
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
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : undefined;
    const deleted = await clearProfileMemories(scope);
    return res.json({ status: "ok", deleted });
  } catch (error) {
    return sendMemoryError(res, error);
  }
});

export default router;
