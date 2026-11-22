import express from "express";
import { validateMcpTransport } from "./mcpRouter.js";
import { MCP_PROTOCOL_VERSION } from "../services/mcpReadService.js";
import {
  assertMcpGrantActive,
  CHATGPT_MCP_SCOPE,
  getMcpAuthorizationServerMetadata,
  MCP_OFFLINE_ACCESS_SCOPE,
  McpOAuthError,
  resolveChatGptMcpResource,
  verifyMcpAccessToken,
} from "../services/mcpOAuthService.js";
import { requestAiText } from "../services/aiCoreService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import {
  getProductPlansService,
  ProductError,
} from "../services/productPlansService.js";

const securitySchemes = [{ type: "oauth2", scopes: [CHATGPT_MCP_SCOPE] }];

const tools = [
  {
    name: "ask_synchron_x",
    title: "Ask SYNCHRON-X",
    description:
      "Get a SYNCHRON-X answer to a specific question using the connected account. Costs three AI credits for standard accounts. Send only the question and context the user chose to share.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 6000 },
      },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_synchron_x_balance",
    title: "Check SYNCHRON-X balance",
    description:
      "Read the AI credit balance of the connected SYNCHRON-X account.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
].map((tool) => ({
  ...tool,
  securitySchemes,
  _meta: { securitySchemes },
}));

function result(content, metadata) {
  return {
    content: [{ type: "text", text: content }],
    ...(metadata ? { isError: true, _meta: metadata } : {}),
  };
}

export function getChatGptMcpResourceMetadata(env = process.env) {
  return {
    resource: resolveChatGptMcpResource(env),
    authorization_servers: [getMcpAuthorizationServerMetadata(env).issuer],
    scopes_supported: [CHATGPT_MCP_SCOPE, MCP_OFFLINE_ACCESS_SCOPE],
  };
}

export function createChatGptMcpRouter({
  env = process.env,
  verify = verifyMcpAccessToken,
  assertGrant = assertMcpGrantActive,
  getUsage = (identity) => getProductPlansService().usage(identity),
  ask = requestAiText,
  budget = publicAiBudgetContext,
} = {}) {
  const router = express.Router();
  const metadata = getChatGptMcpResourceMetadata(env);
  const discovery =
    metadata.authorization_servers[0] +
    "/.well-known/oauth-protected-resource/mcp/chatgpt";
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  async function authenticate(req, res, next) {
    if (req.body?.method !== "tools/call") return next();
    try {
      const identity = verify(
        req.get("authorization"),
        [CHATGPT_MCP_SCOPE],
        env,
        {
          expectedResource: metadata.resource,
        },
      );
      if (!identity)
        throw new McpOAuthError(
          "Connect your SYNCHRON-X account.",
          401,
          "invalid_token",
        );
      await assertGrant(identity, { env });
      req.owner = identity;
      return budget(req, res, next);
    } catch (error) {
      const status = error instanceof McpOAuthError ? error.status : 503;
      if (status !== 401 && status !== 403)
        return res
          .status(503)
          .json({
            jsonrpc: "2.0",
            id: req.body.id ?? null,
            error: {
              code: -32002,
              message: "Account validation is temporarily unavailable.",
            },
          });
      const code = status === 403 ? "insufficient_scope" : "invalid_token";
      const challenge = `Bearer resource_metadata="${discovery}", scope="${CHATGPT_MCP_SCOPE}", error="${code}"`;
      res.set("WWW-Authenticate", challenge);
      return res.status(status).json({
        jsonrpc: "2.0",
        id: req.body.id ?? null,
        result: result("Connect your SYNCHRON-X account.", {
          "mcp/www_authenticate": [challenge],
        }),
      });
    }
  }

  router.post(
    "/",
    (req, res, next) => validateMcpTransport(req, res, next, { env }),
    authenticate,
    async (req, res) => {
      const { id = null, method, params, jsonrpc } = req.body ?? {};
      const reply = (value) => res.json({ jsonrpc: "2.0", id, result: value });
      const failure = (code, message) =>
        res.json({ jsonrpc: "2.0", id, error: { code, message } });
      if (jsonrpc !== "2.0") return failure(-32600, "Invalid MCP request.");
      if (method === "initialize")
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "synchron-x", version: "0.1.0" },
        });
      if (method === "notifications/initialized") return res.status(202).end();
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools });
      if (method !== "tools/call")
        return failure(-32601, "Unknown MCP method.");

      try {
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args))
          return failure(-32602, "Expected an argument object.");
        if (params?.name === "get_synchron_x_balance") {
          if (Object.keys(args).length)
            return failure(-32602, "This tool takes no arguments.");
          const usage = await getUsage(req.owner);
          return reply(
            result(
              usage.owner
                ? "Owner account."
                : `Remaining AI credits: ${usage.remaining}.`,
            ),
          );
        }
        if (params?.name === "ask_synchron_x") {
          const question =
            typeof args.question === "string" ? args.question.trim() : "";
          if (
            !question ||
            question.length > 6000 ||
            Object.keys(args).length !== 1
          )
            return failure(
              -32602,
              "Enter a question of up to 6000 characters.",
            );
          const answer = await ask({
            provider: "openai",
            input: [{ role: "user", content: question }],
          });
          return reply(result(answer));
        }
        return failure(-32602, "Unknown SYNCHRON-X tool.");
      } catch (error) {
        const message =
          error instanceof ProductError
            ? error.message
            : "SYNCHRON-X is temporarily unavailable. Try again shortly.";
        return reply({ ...result(message), isError: true });
      }
    },
  );

  return router;
}
