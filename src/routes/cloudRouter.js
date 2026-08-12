import express from "express";

const router = express.Router();

router.post("/", (req, res) => {
  const { module, action } = req.body || {};
  if (module === "system" && action === "heartbeat") {
    return res.json({
      status: "ok",
      data: {
        module: "system",
        action: "heartbeat",
        time: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
  }

  return res.status(410).json({
    status: "error",
    code: "LEGACY_CLOUD_ROUTE_REMOVED",
    message:
      "Този стар маршрут не изпълнява памет или модули. Използвай официалните AI CORE API маршрути.",
  });
});

export default router;
