import express from "express";
import { getSystemConfigurationReport } from "../services/systemConfigurationService.js";

const router = express.Router();

router.get("/configuration", async (_req, res) => {
  const report = await getSystemConfigurationReport();
  res.json(report);
});

export default router;
