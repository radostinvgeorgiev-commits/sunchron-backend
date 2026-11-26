import express from "express";

import { ShareError } from "../services/shareService.js";

function shareUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/s/${token}`;
}

function sendError(res, error, fallback) {
  if (error instanceof ShareError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(503).json({ error: fallback, code: "SHARE_UNAVAILABLE" });
}

// Signed-in owner or member: make, check and remove links to their own chats.
export function createShareRouter({ service }) {
  const router = express.Router();
  const owner = (req) => req.owner?.memoryOwnerId;

  router.get("/:sessionId", async (req, res) => {
    try {
      const result = await service.status({ ownerId: owner(req), sessionId: req.params.sessionId });
      res.json(result.shared ? { shared: true, url: shareUrl(req, result.token) } : { shared: false });
    } catch (error) {
      sendError(res, error, "Връзката не може да се провери.");
    }
  });

  router.post("/", async (req, res) => {
    try {
      const result = await service.create({
        ownerId: owner(req),
        sessionId: req.body?.sessionId,
        title: req.body?.title,
      });
      res.json({ shared: true, url: shareUrl(req, result.token), messages: result.messages });
    } catch (error) {
      sendError(res, error, "Връзката не беше създадена.");
    }
  });

  router.delete("/:sessionId", async (req, res) => {
    try {
      res.json(await service.remove({ ownerId: owner(req), sessionId: req.params.sessionId }));
    } catch (error) {
      sendError(res, error, "Връзката не беше спряна.");
    }
  });

  return router;
}

// Public, no sign-in: the copy behind a link.
export function createSharedReadRouter({ service }) {
  const router = express.Router();
  router.get("/:token", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    try {
      const shared = await service.read(req.params.token);
      if (!shared) {
        return res.status(404).json({ error: "Връзката не съществува или е спряна.", code: "SHARE_NOT_FOUND" });
      }
      return res.json(shared);
    } catch {
      return res.status(503).json({ error: "Разговорът временно не може да се отвори.", code: "SHARE_UNAVAILABLE" });
    }
  });
  return router;
}
