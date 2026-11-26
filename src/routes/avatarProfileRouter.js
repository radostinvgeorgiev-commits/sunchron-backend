import express from "express";

import { AVATAR_PROFILE_FIELDS, AvatarProfileError } from "../services/avatarProfileService.js";

export function createAvatarProfileRouter({ service }) {
  const router = express.Router();
  const fail = (res, error, fallback) =>
    error instanceof AvatarProfileError
      ? res.status(error.status).json({ error: error.message, code: error.code })
      : res.status(503).json({ error: fallback, code: "AVATAR_PROFILE_UNAVAILABLE" });

  router.get("/", async (req, res) => {
    try {
      res.json({ profile: await service.read(req.owner?.memoryOwnerId), fields: AVATAR_PROFILE_FIELDS });
    } catch (error) {
      fail(res, error, "Профилът не може да се зареди.");
    }
  });
  router.put("/", async (req, res) => {
    try {
      res.json({
        profile: await service.save(req.owner?.memoryOwnerId, req.body?.profile ?? req.body),
        fields: AVATAR_PROFILE_FIELDS,
      });
    } catch (error) {
      fail(res, error, "Профилът не беше записан.");
    }
  });
  return router;
}
