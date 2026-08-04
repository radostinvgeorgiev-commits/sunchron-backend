import express from "express";
import {
  createMcpRequestHandler,
  isValidMcpToken,
  MCP_PROTOCOL_VERSION,
} from "../services/mcpReadService.js";
import {
  allowsAnonymousMcpTool,
  buildMcpAuthenticateChallenge,
  McpOAuthError,
  requiredScopesForMcpTool,
  verifyMcpAccessToken,
} from "../services/mcpOAuthService.js";

const router = express.Router();
const handleMcpRequest = createMcpRequestHandler();
const DEFAULT_ALLOWED_MCP_ORIGINS = Object.freeze([
  "https://synchron.foundation",
  "https://www.synchron.foundation",
  "https://chatgpt.com",
]);
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2025-03-26",
  MCP_PROTOCOL_VERSION,
]);

function allowedMcpOrigins(env = process.env) {
  const configured = String(env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(
    configured.length > 0 ? configured : DEFAULT_ALLOWED_MCP_ORIGINS,
  );
}

export function validateMcpTransport(
  req,
  res,
  next,
  { env = process.env } = {},
) {
  const origin = req.get("origin");
  if (origin && !allowedMcpOrigins(env).has(origin)) {
    return res.status(403).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32000, message: "Неразрешен Origin за MCP заявка." },
    });
  }

  const requestedVersion = req.get("mcp-protocol-version");
  const isInitialization = req.body?.method === "initialize";
  if (
    !isInitialization &&
    requestedVersion &&
    !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)
  ) {
    return res.status(400).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: -32600,
        message: "Неподдържана MCP протоколна версия.",
      },
    });
  }

  return next();
}

export function mcpJsonParseErrorHandler(error, req, res, next) {
  if (error?.type !== "entity.parse.failed") return next(error);
  return res.status(400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Невалиден JSON в MCP заявката." },
  });
}

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
    req.mcpAuthentication = {
      mode: "legacy-static-bearer",
      id: "owner",
      role: "owner",
      displayName: "Радко",
    };
    return next();
  }

  if (!authorization && allowsAnonymousMcpTool(toolName)) {
    req.mcpOwnerId = null;
    req.mcpAuthentication = {
      mode: "noauth",
      id: "anonymous",
      role: "anonymous",
      displayName: "Публична проверка",
    };
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
      : {
          error: "invalid_token",
          description: "OAuth access token is required.",
        },
  );
  res.set("WWW-Authenticate", challenge);
  const message = authorization
    ? oauthError?.message || "Невалиден или изтекъл MCP token."
    : "Нужно е OAuth свързване със AI CORE.";
  return res.status(oauthError?.status === 403 ? 403 : 401).json({
    jsonrpc: "2.0",
    id: req.body?.id ?? null,
    result: {
      content: [{ type: "text", text: message }],
      _meta: {
        "mcp/www_authenticate": [challenge],
      },
      isError: true,
    },
  });
}

router.post(
  "/",
  validateMcpTransport,
  requireMcpAuthorization,
  async (req, res) => {
    const response = await handleMcpRequest(
      req.body,
      req.mcpOwnerId,
      req.mcpAuthentication,
    );
    if (!response) return res.status(202).end();
    return res.json(response);
  },
);

router.get("/", (_req, res) =>
  res.status(405).json({
    error: "Използвай MCP Streamable HTTP POST заявка.",
  }),
);

export default router;
