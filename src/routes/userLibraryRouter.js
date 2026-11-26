import express from "express";

import { LIBRARY_LIMITS, UserLibraryError } from "../services/userLibraryService.js";

export function createUserLibraryRouter({ service }) {
  const router = express.Router();
  const fail = (res, error, fallback) =>
    error instanceof UserLibraryError
      ? res.status(error.status).json({ error: error.message, code: error.code })
      : res.status(503).json({ error: fallback, code: "LIBRARY_UNAVAILABLE" });

  router.get("/", async (req, res) => {
    try {
      res.json({ ...(await service.read(req.owner?.memoryOwnerId)), limits: LIBRARY_LIMITS });
    } catch (error) {
      fail(res, error, "Библиотеката не може да се зареди.");
    }
  });
  router.put("/", async (req, res) => {
    try {
      res.json({ ...(await service.save(req.owner?.memoryOwnerId, req.body || {})), limits: LIBRARY_LIMITS });
    } catch (error) {
      fail(res, error, "Библиотеката не беше записана.");
    }
  });
  return router;
}
