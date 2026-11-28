import express from "express";

import { BookMemoryError } from "../services/bookMemoryService.js";
import { publicSpecialistProfile, publicSpecialistProfiles, specialistProfile } from "../services/specialistProfiles.js";
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

  // ?domain=lawyer lists only that specialist's projects; a book saved
  // before specialists had their own memory belongs to the writer.
  router.get(
    "/",
    handle("Книгите не могат да се заредят.", async (req) => {
      const books = await service.list(owner(req));
      if (!req.query.domain) return { books };
      const profile = publicSpecialistProfile(String(req.query.domain));
      return { books: books.filter((book) => specialistProfile(book.domain).id === profile.id), profile };
    }),
  );
  router.get("/profiles", (_req, res) => res.json({ profiles: publicSpecialistProfiles() }));
  router.post(
    "/",
    handle("Книгата не беше създадена.", async (req) => ({ book: await service.createBook(owner(req), req.body?.title, req.body?.domain) }), 201),
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
  // Chapters: save one or many (an imported manuscript), read, delete.
  router.post(
    "/:bookId/chapters",
    handle("Главите не бяха записани.", async (req) => ({
      book: await service.saveChapters(owner(req), req.params.bookId, req.body?.chapters ?? req.body),
    })),
  );
  router.get(
    "/:bookId/chapters/:number",
    handle("Главата не може да се зареди.", async (req) => ({
      chapter: await service.getChapter(owner(req), req.params.bookId, req.params.number),
    })),
  );
  router.delete(
    "/:bookId/chapters/:number",
    handle("Главата не беше изтрита.", async (req) => ({
      book: await service.removeChapter(owner(req), req.params.bookId, req.params.number),
    })),
  );
  // The finished book as a file. "html" is the print page for PDF.
  router.get("/:bookId/export", async (req, res) => {
    try {
      const file = await service.exportBook(owner(req), req.params.bookId, String(req.query.format || ""));
      res.setHeader("Content-Type", file.type);
      res.setHeader("Cache-Control", "no-store");
      if (!file.type.startsWith("text/html")) {
        res.setHeader("Content-Disposition", `attachment; filename="book.${file.name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      }
      res.send(file.body);
    } catch (error) {
      fail(res, error, "Книгата не можа да се изтегли.");
    }
  });
  router.post(
    "/:bookId/draft",
    publicAiBudgetContext,
    handle("Черновата не стана. Опитай пак.", async (req) => ({
      draft: await service.draftChapter(owner(req), req.params.bookId, req.body || {}),
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
