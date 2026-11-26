import express from "express";

import { AvatarLinkError } from "../services/avatarLinkService.js";
import { logSafeError } from "../utils/safeLogging.js";

const linkUrl = (req, token) => `${req.protocol}://${req.get("host")}/a/${token}`;
const fail = (res, error, fallback) => {
  if (error instanceof AvatarLinkError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logSafeError("[Avatar link]", error);
  return res.status(503).json({ error: fallback, code: "AVATAR_LINK_UNAVAILABLE" });
};
const view = (req, result) => {
  const { token, ...rest } = result;
  return token ? { ...rest, url: linkUrl(req, token) } : rest;
};

// Signed in: the person's own link.
export function createAvatarLinkRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;
  router.get("/", async (req, res) => {
    try {
      res.json(view(req, await service.status(owner(req))));
    } catch (error) {
      fail(res, error, "Линкът не може да се провери.");
    }
  });
  router.put("/", async (req, res) => {
    try {
      res.json(view(req, await service.save(owner(req), req.body?.card ?? req.body)));
    } catch (error) {
      fail(res, error, "Линкът не беше записан.");
    }
  });
  router.delete("/", async (req, res) => {
    try {
      res.json(await service.stop(owner(req)));
    } catch (error) {
      fail(res, error, "Линкът не беше спрян.");
    }
  });
  return router;
}

// Public, no sign-in: the visitor's side of a link.
export function createAvatarVisitorRouter({ service }) {
  const router = express.Router();
  const gone = (res) =>
    res.status(404).json({ error: "Този аватар не е достъпен или линкът е спрян.", code: "AVATAR_LINK_NOT_FOUND" });
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  router.get("/:token", async (req, res) => {
    try {
      const card = await service.card(req.params.token);
      return card ? res.json(card) : gone(res);
    } catch (error) {
      return fail(res, error, "Аватарът временно не е достъпен.");
    }
  });
  router.post("/:token/ask", async (req, res) => {
    try {
      const result = await service.ask(req.params.token, {
        question: req.body?.question,
        history: req.body?.history,
      });
      return result ? res.json(result) : gone(res);
    } catch (error) {
      return fail(res, error, "Аватарът не можа да отговори. Опитай пак.");
    }
  });
  return router;
}
