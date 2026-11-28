import express from "express";
import {
  createMcpRequestHandler,
  isValidMcpToken,
  MCP_PROTOCOL_VERSION,
} from "../services/mcpReadService.js";
import {
  allowsAnonymousMcpTool,
  assertMcpGrantActive,
  buildMcpAuthenticateChallenge,
  McpOAuthError,
  requiredScopesForMcpTool,
  verifyMcpAccessToken,
} from "../services/mcpOAuthService.js";

const router = express.Router();
const handleMcpRequest = createMcpRequestHandler();
const DEFAULT_ALLOWED_MCP_ORIGINS = Object.freeze([
  "https://cloudaicore.com",
  "https://novariumai.com",
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
  return new Set([
    ...(configured.length > 0 ? configured : DEFAULT_ALLOWED_MCP_ORIGINS),
    "https://novariumai.com",
  ]);
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

// Tool names from before the rename to NovariumAI (#573). A connector that
// still keeps the old tool list goes on working until it refreshes it;
// tools/list shows only the new names.
export const LEGACY_MCP_TOOL_NAMES = Object.freeze({
  run_ai_core_self_test: "run_novarium_self_test",
  talk_to_ai_core: "talk_to_novarium",
});

// Runs before authorization, so an old name asks for the same scope as the
// new one and the rest of the server only ever sees the new name.
export function renameLegacyMcpTools(legacyNames) {
  return (req, _res, next) => {
    const params = req.body?.params;
    const name = params?.name;
    if (
      req.body?.method === "tools/call" &&
      typeof name === "string" &&
      Object.hasOwn(legacyNames, name)
    ) {
      params.name = legacyNames[name];
      console.log(`[MCP] old tool name ${name} → ${params.name}.`);
    }
    return next();
  };
}

export function mcpJsonParseErrorHandler(error, req, res, next) {
  if (error?.type !== "entity.parse.failed") return next(error);
  return res.status(400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Невалиден JSON в MCP заявката." },
  });
}

function sendMcpAuthorizationError(req, res, { challenge, message, status }) {
  res.set("WWW-Authenticate", challenge);
  return res.status(status).json({
    jsonrpc: "2.0",
    id: req.body?.id ?? null,
    result: {
      content: [{ type: "text", text: message }],
      _meta: { "mcp/www_authenticate": [challenge] },
      isError: true,
    },
  });
}

function sendMcpAuthorizationUnavailable(req, res) {
  return res.status(503).json({
    jsonrpc: "2.0",
    id: req.body?.id ?? null,
    error: {
      code: -32002,
      message: "MCP OAuth validation is temporarily unavailable.",
    },
  });
}

export async function requireMcpAuthorization(
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
    if (identity) await assertMcpGrantActive(identity, { env });
  } catch (error) {
    identity = null;
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
  if (oauthError?.status >= 500) {
    return sendMcpAuthorizationUnavailable(req, res);
  }

  const challengeError = oauthError?.code || "invalid_token";
  const challengeDescription =
    challengeError === "insufficient_scope"
      ? "The access token does not include the required scope."
      : "The access token is missing, invalid, expired, or revoked.";
  const challenge = buildMcpAuthenticateChallenge(requiredScopes, env, {
    error: challengeError,
    description: challengeDescription,
    host: req.get("host"),
  });
  if (authorization) {
    return sendMcpAuthorizationError(req, res, {
      challenge,
      message: oauthError?.message || "Невалиден или изтекъл MCP token.",
      status: oauthError?.status === 403 ? 403 : 401,
    });
  }
  return sendMcpAuthorizationError(req, res, {
    challenge,
    message: "Нужно е OAuth свързване със NovariumAI.",
    status: 401,
  });
}

router.post(
  "/",
  validateMcpTransport,
  renameLegacyMcpTools(LEGACY_MCP_TOOL_NAMES),
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
