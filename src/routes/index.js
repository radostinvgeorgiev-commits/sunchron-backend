import express from "express";
import cloudRouter from "./cloudRouter.js";
import memoryRouter from "./memoryRouter.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({
    api: "synchron-backend",
    status: "online",
    time: new Date().toISOString()
  });
});

router.use("/route", cloudRouter);
router.use("/memory", memoryRouter);

export default router;
