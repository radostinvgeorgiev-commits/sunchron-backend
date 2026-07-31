import express from "express";
import {
  createMcpRequestHandler,
  isValidMcpToken,
} from "../services/mcpReadService.js";
import {
  buildMcpAuthenticateChallenge,
  McpOAuthError,
  requiredScopesForMcpTool,
  verifyMcpAccessToken,
} from "../services/mcpOAuthService.js";

const router = express.Router();
const handleMcpRequest = createMcpRequestHandler();

export function requireMcpAuthorization(
  req,
  res,
  next,
  { env = process.env } = {},
) {
  if (req.body?.method !== "tools/call") return next();

  const toolName = req.body?.params?.name;
  const requiredScopes = requiredScopesForMcpTool(toolName);
  const authorization = req.get("authorization");
  if (isValidMcpToken(authorization, env.MCP_ACCESS_TOKEN)) {
    req.mcpOwnerId = env.MEMORY_OWNER_ID || "primary-user";
    req.mcpAuthentication = { mode: "legacy-static-bearer", role: "owner" };
    return next();
  }

  let identity = null;
  let oauthError = null;
  try {
    identity = verifyMcpAccessToken(authorization, requiredScopes, env);
  } catch (error) {
    oauthError =
      error instanceof McpOAuthError
        ? error
        : new McpOAuthError(
            "Невалиден или изтекъл MCP token.",
            401,
            "invalid_token",
          );
  }
  if (identity) {
    req.mcpOwnerId = identity.memoryOwnerId;
    req.mcpAuthentication = { mode: "oauth2", ...identity };
    return next();
  }

  const challenge = buildMcpAuthenticateChallenge(
    requiredScopes,
    env,
    oauthError
      ? {
          error: oauthError.code,
          description: oauthError.description,
        }
      : {},
  );
  res.set("WWW-Authenticate", challenge);
  if (authorization) {
    return res.status(oauthError?.status === 403 ? 403 : 401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: -32001,
        message: oauthError?.message || "Невалиден или изтекъл MCP token.",
      },
    });
  }
  return res.json({
    jsonrpc: "2.0",
    id: req.body?.id ?? null,
    result: {
      content: [
        {
          type: "text",
          text: "Нужно е OAuth свързване със СЪЗВУК.",
        },
      ],
      isError: true,
      _meta: { "mcp/www_authenticate": [challenge] },
    },
  });
}

router.post("/", requireMcpAuthorization, async (req, res) => {
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
