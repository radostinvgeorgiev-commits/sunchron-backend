import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { renameLegacyMcpTools, validateMcpTransport } from "./mcpRouter.js";
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
import { requestAiText } from "../services/novariumService.js";
import { publicAiBudgetContext } from "../services/publicAiBudget.js";
import {
  getProductPlansService,
  ProductError,
} from "../services/productPlansService.js";

import {
  listConversationMessages,
  saveConversationTurn,
} from "../services/memoryService.js";
import { logSafeError } from "../utils/safeLogging.js";

const widgetUri = "ui://novarium/workspace-v1.html";
// Names and the widget address from before the rename to NovariumAI (#573),
// for a ChatGPT app that still keeps the old tool list.
export const LEGACY_CHATGPT_TOOL_NAMES = Object.freeze({
  open_synchron_x_workspace: "open_novarium_workspace",
  ask_synchron_x: "ask_novarium",
  get_synchron_x_balance: "get_novarium_balance",
});
const widgetUris = new Set([widgetUri, "ui://synchron-x/workspace-v1.html"]);
const widget = {
  uri: widgetUri,
  name: "NovariumAI workspace",
  mimeType: "text/html;profile=mcp-app",
};
const conversationIdPattern =
  /^chatgpt-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

const securitySchemes = [{ type: "oauth2", scopes: [CHATGPT_MCP_SCOPE] }];

const tools = [
  {
    name: "open_novarium_workspace",
    title: "Open NovariumAI workspace",
    description:
      "Open the interactive NovariumAI workspace in the current ChatGPT conversation.",
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
  {
    name: "ask_novarium",
    title: "Ask NovariumAI",
    description:
      "Get a NovariumAI answer to a specific question using the connected account. Costs three AI credits for standard accounts and saves the question and answer to the connected account. Send only the question and context the user chose to share.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 6000 },
        sessionId: { type: "string", pattern: conversationIdPattern.source },
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
    name: "get_novarium_balance",
    title: "Check NovariumAI balance",
    description:
      "Read the AI credit balance of the connected NovariumAI account.",
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
  _meta: {
    securitySchemes,
    ...(tool.name === "open_novarium_workspace"
      ? { ui: { resourceUri: widgetUri } }
      : {}),
  },
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
  listMessages = listConversationMessages,
  saveTurn = saveConversationTurn,
} = {}) {
  const router = express.Router();
  const widgetHtml = readFileSync(
    new URL("./novarium-widget.html", import.meta.url),
    "utf8",
  );
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
          "Connect your NovariumAI account.",
          401,
          "invalid_token",
        );
      await assertGrant(identity, { env });
      req.owner = identity;
      return budget(req, res, next);
    } catch (error) {
      const status = error instanceof McpOAuthError ? error.status : 503;
      if (status !== 401 && status !== 403)
        return res.status(503).json({
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
        result: result("Connect your NovariumAI account.", {
          "mcp/www_authenticate": [challenge],
        }),
      });
    }
  }

  router.post(
    "/",
    (req, res, next) => validateMcpTransport(req, res, next, { env }),
    renameLegacyMcpTools(LEGACY_CHATGPT_TOOL_NAMES),
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
          capabilities: { tools: { listChanged: false }, resources: {} },
          serverInfo: { name: "novarium", version: "0.2.0" },
        });
      if (method === "notifications/initialized") return res.status(202).end();
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools });
      if (method === "resources/list") return reply({ resources: [widget] });
      if (method === "resources/read") {
        if (!widgetUris.has(params?.uri))
          return failure(-32002, "Unknown resource.");
        return reply({
          contents: [
            {
              ...widget,
              uri: params.uri,
              text: widgetHtml,
              _meta: {
                ui: { csp: { resourceDomains: ["https://cloudaicore.com"] } },
              },
            },
          ],
        });
      }
      if (method !== "tools/call")
        return failure(-32601, "Unknown MCP method.");

      try {
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args))
          return failure(-32602, "Expected an argument object.");
        if (params?.name === "open_novarium_workspace") {
          if (Object.keys(args).length)
            return failure(-32602, "This tool takes no arguments.");
          return reply(result("NovariumAI is open."));
        }
        if (params?.name === "get_novarium_balance") {
          if (Object.keys(args).length)
            return failure(-32602, "This tool takes no arguments.");
          const usage = await getUsage(req.owner);
          return reply({
            ...result(
              usage.owner
                ? "Owner account."
                : `Remaining AI credits: ${usage.remaining}.`,
            ),
            structuredContent: {
              remaining: usage.remaining ?? null,
              owner: Boolean(usage.owner),
            },
          });
        }
        if (params?.name === "ask_novarium") {
          const question =
            typeof args.question === "string" ? args.question.trim() : "";
          if (
            !question ||
            question.length > 6000 ||
            (args.sessionId !== undefined &&
              (typeof args.sessionId !== "string" ||
                !conversationIdPattern.test(args.sessionId))) ||
            Object.keys(args).some(
              (key) => key !== "question" && key !== "sessionId",
            )
          )
            return failure(
              -32602,
              "Enter a question of up to 6000 characters.",
            );
          const sessionId = args.sessionId ?? `chatgpt-${randomUUID()}`;
          const ownerId = req.owner.memoryOwnerId;
          const history = args.sessionId
            ? await listMessages(sessionId, 8, ownerId)
            : [];
          const input = history
            .filter(
              (item) =>
                ["user", "assistant"].includes(item.role) &&
                typeof item.content === "string",
            )
            .map((item) => ({
              role: item.role,
              content: item.content.slice(0, 2000),
            }));
          input.push({ role: "user", content: question });
          const answer = await ask({ provider: "openai", input });
          let conversationPersisted = true;
          try {
            await saveTurn(sessionId, question, answer, ownerId);
          } catch (error) {
            conversationPersisted = false;
            logSafeError("[NovariumAI plugin] Save conversation", error);
          }
          return reply({
            ...result(answer),
            structuredContent: { answer, sessionId, conversationPersisted },
          });
        }
        return failure(-32602, "Unknown NovariumAI tool.");
      } catch (error) {
        const message =
          error instanceof ProductError
            ? error.message
            : "NovariumAI is temporarily unavailable. Try again shortly.";
        return reply({ ...result(message), isError: true });
      }
    },
  );

  return router;
}
