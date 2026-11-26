import express from "express";

import { ProductError } from "../services/productPlansService.js";
import { PersonalTodoError } from "../services/personalTodoService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";

export function createPersonalTodoRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const fail = (res, error, fallback) => {
    if (error instanceof PersonalTodoError || error instanceof ProductError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logSafeError("[Todos]", error);
    return res.status(503).json({ error: fallback, code: "TODOS_UNAVAILABLE" });
  };

  router.get("/", async (req, res) => {
    try {
      res.json({ items: await service.list(owner(req)) });
    } catch (error) {
      fail(res, error, "Задачите не могат да се заредят.");
    }
  });
  router.post("/", async (req, res) => {
    try {
      res.status(201).json({ items: await service.add(owner(req), req.body?.items ?? req.body?.text) });
    } catch (error) {
      fail(res, error, "Задачата не беше записана.");
    }
  });
  // One AI request that only suggests tasks; nothing is saved here.
  router.post("/from-note", publicAiBudgetContext, async (req, res) => {
    try {
      res.json({ suggestions: await service.fromNote(req.body?.note) });
    } catch (error) {
      fail(res, error, "Бележката не можа да стане на задачи. Опитай пак.");
    }
  });
  router.patch("/:id", async (req, res) => {
    try {
      res.json({ items: await service.setDone(owner(req), req.params.id, req.body?.done === true) });
    } catch (error) {
      fail(res, error, "Задачата не беше променена.");
    }
  });
  router.delete("/:id", async (req, res) => {
    try {
      res.json({ items: await service.remove(owner(req), req.params.id) });
    } catch (error) {
      fail(res, error, "Задачата не беше изтрита.");
    }
  });
  return router;
}
