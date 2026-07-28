import express from "express";
import {
  createMcpRequestHandler,
  isValidMcpToken,
} from "../services/mcpReadService.js";

const router = express.Router();
const handleMcpRequest = createMcpRequestHandler();

export function requireMcpToken(req, res, next) {
  if (!isValidMcpToken(req.get("authorization"), process.env.MCP_ACCESS_TOKEN)) {
    res.set("WWW-Authenticate", 'Bearer realm="SYNCHRON-X MCP"');
    return res.status(401).json({ error: "MCP удостоверяването е задължително." });
  }
  req.mcpOwnerId = process.env.MEMORY_OWNER_ID || "primary-user";
  return next();
}

router.post("/", requireMcpToken, async (req, res) => {
  const response = await handleMcpRequest(req.body, req.mcpOwnerId);
  if (!response) return res.status(202).end();
  return res.json(response);
});

router.get("/", (_req, res) =>
  res.status(405).json({
    error: "Използвай MCP Streamable HTTP POST заявка.",
  }),
);

export default router;
