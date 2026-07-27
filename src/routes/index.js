import express from "express";
import cloudRouter from "./cloudRouter.js";
import memoryRouter from "./memoryRouter.js";

const router = express.Router();
const LEGACY_NOTICE =
  "Legacy router: runtime source of truth is /server.js with direct route mounting.";

router.get("/status", (req, res) => {
  res.json({
    api: "synchron-backend",
    status: "legacy",
    runtimeSourceOfTruth: "server.js",
    legacy: true,
    notice: LEGACY_NOTICE,
    time: new Date().toISOString(),
  });
});

router.use("/route", cloudRouter);
router.use("/memory", memoryRouter);

export default router;
