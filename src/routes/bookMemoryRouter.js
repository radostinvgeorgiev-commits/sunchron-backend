import express from "express";

import { BookMemoryError } from "../services/bookMemoryService.js";
import { ProductError } from "../services/productPlansService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import { logSafeError } from "../utils/safeLogging.js";

// "Писател": the person's own books and the memory of each one.
export function createBookMemoryRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const fail = (res, error, fallback) => {
    if (error instanceof BookMemoryError || error instanceof ProductError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logSafeError("[Books]", error);
    return res.status(503).json({ error: fallback, code: "BOOKS_UNAVAILABLE" });
  };
  const handle = (fallback, work, status = 200) => async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (error) {
      fail(res, error, fallback);
    }
  };

  router.get("/", handle("Книгите не могат да се заредят.", async (req) => ({ books: await service.list(owner(req)) })));
  router.post(
    "/",
    handle("Книгата не беше създадена.", async (req) => ({ book: await service.createBook(owner(req), req.body?.title) }), 201),
  );
  router.delete(
    "/:bookId",
    handle("Книгата не беше изтрита.", async (req) => ({ books: await service.removeBook(owner(req), req.params.bookId) })),
  );
  router.post(
    "/:bookId/facts",
    handle("Фактите не бяха записани.", async (req) => ({
      book: await service.addFacts(owner(req), req.params.bookId, req.body?.facts ?? req.body?.fact),
    })),
  );
  router.delete(
    "/:bookId/facts/:factId",
    handle("Фактът не беше изтрит.", async (req) => ({
      book: await service.removeFact(owner(req), req.params.bookId, req.params.factId),
    })),
  );
  router.post(
    "/:bookId/facts/:factId/change",
    handle("Промяната не беше записана.", async (req) => ({
      book: await service.changeFact(owner(req), req.params.bookId, req.params.factId, req.body || {}),
    })),
  );
  // The two AI requests: suggestions (nothing saved) and the chapter check.
  router.post(
    "/:bookId/suggest",
    publicAiBudgetContext,
    handle("Фактите не можаха да се извадят. Опитай пак.", async (req) => ({
      suggestions: await service.suggestFacts(owner(req), req.params.bookId, req.body || {}),
    })),
  );
  router.post(
    "/:bookId/check",
    publicAiBudgetContext,
    handle("Главата не можа да се провери. Опитай пак.", async (req) => ({
      result: await service.checkChapter(owner(req), req.params.bookId, req.body || {}),
    })),
  );
  return router;
}
