import { timingSafeEqual } from "node:crypto";
import {
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
} from "./memoryService.js";
import { recordAuditEvent } from "./permissionService.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});

export const MCP_TOOLS = Object.freeze([
  {
    name: "get_personal_context",
    title: "Прочети личния контекст",
    description:
      "Прочита проверените лични факти за Радко от постоянната памет на SYNCHRON-X. Използвай само когато са нужни за текущия въпрос.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_project_context",
    title: "Прочети контекста на проекта",
    description:
      "Прочита проверените факти за NOVARIUM / SYNCHRON-X. Не ги смесвай с личните факти за Радко.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_synchron_conversations",
    title: "Покажи разговорите в SYNCHRON-X",
    description:
      "Показва списък със запазените разговори в собствения чат на SYNCHRON-X.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_synchron_conversation",
    title: "Прочети разговор от SYNCHRON-X",
    description:
      "Прочита избран разговор от собствения чат на SYNCHRON-X по неговия sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
]);

function textResult(data, summary) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

function safeLimit(value, fallback = 20) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : fallback;
}

export function isValidMcpToken(header, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createMcpRequestHandler({
  listMemories = listProfileMemories,
  listConversations = listConversationSummaries,
  listMessages = listConversationMessages,
  audit = recordAuditEvent,
} = {}) {
  async function callTool(name, args, ownerId) {
    let result;
    if (name === "get_personal_context") {
      const items = await listMemories({ scope: "personal", ownerId });
      result = textResult(
        { scope: "personal", items },
        `Прочетени са ${items.length} лични записа от SYNCHRON-X.`,
      );
    } else if (name === "get_project_context") {
      const items = await listMemories({ scope: "project", ownerId });
      result = textResult(
        { scope: "project", items },
        `Прочетени са ${items.length} проектни записа от SYNCHRON-X.`,
      );
    } else if (name === "list_synchron_conversations") {
      const items = await listConversations(safeLimit(args?.limit), ownerId);
      result = textResult(
        { items },
        `Намерени са ${items.length} разговора в SYNCHRON-X.`,
      );
    } else if (name === "get_synchron_conversation") {
      const sessionId =
        typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId || sessionId.length > 160) {
        throw Object.assign(new Error("Невалиден sessionId."), { code: -32602 });
      }
      const items = await listMessages(sessionId, undefined, ownerId);
      result = textResult(
        { sessionId, items },
        `Прочетени са ${items.length} съобщения от избрания разговор.`,
      );
    } else {
      throw Object.assign(new Error("Непознат MCP инструмент."), {
        code: -32601,
      });
    }

    await audit({
      actor: "chatgpt-mcp",
      action: "memory.read",
      decision: "allow",
      outcome: "succeeded",
      resource: name,
      details: "read-only-mcp",
    });
    return result;
  }

  return async function handleMcpRequest(message, ownerId) {
    if (!message || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Невалидна MCP заявка." },
      };
    }
    if (message.method === "notifications/initialized") return null;
    try {
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "synchron-x-memory", version: "1.0.0" },
            instructions:
              "Използвай паметта само когато е свързана с въпроса. Личният и проектният контекст са различни. Този мост е само за четене.",
          },
        };
      }
      if (message.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: MCP_TOOLS },
        };
      }
      if (message.method === "tools/call") {
        const result = await callTool(
          message.params?.name,
          message.params?.arguments,
          ownerId,
        );
        return { jsonrpc: "2.0", id: message.id, result };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Неподдържан MCP метод." },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: Number.isInteger(error?.code) ? error.code : -32603,
          message:
            error?.code === -32602
              ? error.message
              : "SYNCHRON-X временно не може да прочете исканите данни.",
        },
      };
    }
  };
}
