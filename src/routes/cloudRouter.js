import express from "express";
const router = express.Router();
// Legacy compatibility router. Keep read-only/minimal behavior.
const LEGACY_NOTICE =
  "Legacy Cloud Router. Runtime source of truth is server.js and dedicated routes under /chat, /memory, /github, /calendar, /api/google, /search.";

function ok(data) {
  return {
    status: "ok",
    data,
    timestamp: new Date().toISOString()
  };
}

function error(message) {
  return {
    status: "error",
    message
  };
}

router.post("/", async (req, res) => {
  const { module, action, params } = req.body;
  console.log("CLOUD ROUTER RECEIVED:", req.body);

  try {
    switch (module) {
      case "system":
        if (action === "heartbeat") {
          return res.json(
            ok({
              module: "system",
              action: "heartbeat",
              legacy: true,
              notice: LEGACY_NOTICE,
              time: new Date().toISOString(),
            }),
          );
        }
        break;
      case "memory":
        if (action === "write_memory") {
          return res.json(
            ok({
              operation: "memory.write",
              stored: params?.data || null,
              legacy: true,
              notice: LEGACY_NOTICE,
            }),
          );
        }
        if (action === "get_memory") {
          return res.json(
            ok({
              operation: "memory.get",
              key: params?.key,
              legacy: true,
              notice: LEGACY_NOTICE,
            }),
          );
        }
        if (action === "list_memory") {
          return res.json(
            ok({
              operation: "memory.list",
              items: [],
              legacy: true,
              notice: LEGACY_NOTICE,
            }),
          );
        }
        break;
      default:
        return res.status(400).json(error("Unknown module or action."));
    }
  } catch (err) {
    console.error("ROUTER ERROR:", err);
    return res.status(500).json(error(err.message));
  }
});

export default router;
