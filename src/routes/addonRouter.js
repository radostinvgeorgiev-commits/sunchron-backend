import express from "express";

import { AddonError } from "../services/addonService.js";
import { logSafeError } from "../utils/safeLogging.js";

// "Добавки": /mine is the person's own workshop, /store is what everyone can
// use, /review is the owner's approval queue.
export function createAddonRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  const isProjectOwner = (req) => req.owner?.role === "owner";
  const fail = (res, error, fallback) => {
    if (error instanceof AddonError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logSafeError("[Addons]", error);
    return res.status(503).json({ error: fallback, code: "ADDONS_UNAVAILABLE" });
  };
  const handle = (fallback, work) => async (req, res) => {
    try {
      res.json(await work(req));
    } catch (error) {
      fail(res, error, fallback);
    }
  };
  const ownerOnly = (req, res, next) =>
    isProjectOwner(req)
      ? next()
      : res.status(403).json({ error: "Прегледът е само за собственика.", code: "OWNER_ONLY" });

  router.get("/mine", handle("Добавките не могат да се заредят.", async (req) => ({ items: await service.listMine(owner(req)) })));
  router.post("/mine", handle("Добавката не беше записана.", (req) => service.save(owner(req), req.body || {})));
  router.delete("/mine/:id", handle("Добавката не беше изтрита.", async (req) => ({ items: await service.remove(owner(req), req.params.id) })));
  router.post("/mine/:id/submit", handle("Добавката не беше изпратена.", async (req) => ({ items: await service.submit(owner(req), req.params.id) })));
  router.post("/mine/:id/unpublish", handle("Добавката не беше махната.", async (req) => ({ items: await service.unpublish(owner(req), req.params.id) })));
  router.post("/mine/:id/run", handle("Добавката не можа да се пусне.", (req) => service.runMine(owner(req), req.params.id, req.body?.input)));
  router.post("/test", handle("Пробата не можа да се пусне.", (req) => service.test(owner(req), req.body || {})));

  router.get("/store", handle("Магазинът не може да се зареди.", async () => ({ items: await service.listPublic() })));
  router.post("/store/:id/run", handle("Добавката не можа да се пусне.", (req) => service.runPublic(req.params.id, req.body?.input)));

  router.get("/review", ownerOnly, handle("Прегледът не може да се зареди.", async () => ({ items: await service.listPending() })));
  router.post("/review/:id/run", ownerOnly, handle("Добавката не можа да се пусне.", (req) => service.runPending(req.params.id, req.body?.input)));
  router.post("/review/:id/approve", ownerOnly, handle("Одобрението не мина.", (req) => service.approve(req.params.id, req.body?.note)));
  router.post("/review/:id/reject", ownerOnly, handle("Отказът не мина.", (req) => service.reject(req.params.id, req.body?.note)));
  return router;
}
