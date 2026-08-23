import { timingSafeEqual } from "node:crypto";
import {
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
} from "./memoryService.js";
import {
  executeAuditedWriteAction,
  recordAuditEvent,
} from "./permissionService.js";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import {
  buildMergedBranchCleanupPlan,
  executeMergedBranchCleanup,
} from "./githubBranchCleanupService.js";
import {
  formatGoogleCloudRuntimeStatus,
  getGoogleCloudRuntimeStatus,
} from "./googleCloudService.js";
import {
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "./systemConfigurationService.js";
import {
  mcpToolSecuritySchemes,
} from "./mcpOAuthService.js";
import { sendMcpAgentMessage } from "./mcpAgentConversationService.js";
import {
  createMcpCapabilityHandler,
  MCP_CAPABILITY_TOOLS,
} from "./mcpCapabilityService.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
const DESTRUCTIVE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: false,
});
const CONVERSATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: false,
});
const SAFE_MCP_ERROR_NAMES = new Set([
  "GitHubActionError",
  "GitHubServiceError",
  "GoogleActionError",
  "GoogleCloudActionError",
  "GoogleDriveError",
  "MemoryDeleteConfirmationError",
  "MemoryWriteConfirmationError",
  "TaskManagementError",
  "WorkspaceStateError",
]);
const SAFE_CONFIRMATION_ERROR_CODES = new Set([
  "CONFIRMATION_NOT_FOUND",
  "CONFIRMATION_EXPIRED",
  "SESSION_MISMATCH",
  "CONFIRMATION_PERSISTENCE_FAILED",
]);

export const MCP_TOOLS = Object.freeze([
  {
    name: "get_personal_context",
    title: "Прочети личния контекст",
    description:
      "Прочита проверените лични факти за Радко от постоянната памет на AI CORE. Използвай само когато са нужни за текущия въпрос.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_personal_context"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_project_context",
    title: "Прочети контекста на проекта",
    description:
      "Прочита проверените факти за AI CORE. Не ги смесвай с личните факти за Радко.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_project_context"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_synchron_conversations",
    title: "Покажи разговорите в AI CORE",
    description:
      "Показва списък със запазените разговори в собствения чат на AI CORE.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("list_synchron_conversations"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_synchron_conversation",
    title: "Прочети разговор от AI CORE",
    description:
      "Прочита избран разговор от собствения чат на AI CORE по неговия sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_synchron_conversation"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "talk_to_ai_core",
    title: "Говори с AI CORE",
    description:
      "Изпраща едно съобщение до AI CORE в собствения профил, връща отговора и запазва разговора. Може да продължи същата нишка чрез sessionId. Не изпълнява инструменти, външни действия или промени по код.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 6000 },
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        agentId: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["message"],
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("talk_to_ai_core"),
    annotations: CONVERSATION_ANNOTATIONS,
  },
  {
    name: "get_google_cloud_runtime_status",
    title: "Провери Google Cloud runtime",
    description:
      "Показва текущия Cloud Run runtime, Firestore режима, Identity Platform режима и revision metadata без стойности на secrets. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_google_cloud_runtime_status"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_system_configuration",
    title: "Провери системната конфигурация",
    description:
      "Показва предназначението и състоянието на Google Cloud runtime променливите, ядрото и връзките, без стойности на ключове, пароли или token-и. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_system_configuration"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "prepare_github_merged_branch_cleanup",
    title: "Подготви почистване на слети GitHub клонове",
    description:
      "Проверява кои клонове са от слети PR-и, без отворен PR и без защита. Не изтрива нищо; връща точен списък и еднократно потвърждение.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes(
      "prepare_github_merged_branch_cleanup",
    ),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "confirm_github_merged_branch_cleanup",
    title: "Потвърди изтриването на проверените GitHub клонове",
    description:
      "Изтрива само точния предварително проверен списък след еднократно потвърждение и повторна проверка.",
    inputSchema: {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes(
      "confirm_github_merged_branch_cleanup",
    ),
    annotations: DESTRUCTIVE_ANNOTATIONS,
  },
  ...MCP_CAPABILITY_TOOLS,
]);

function textResult(data, summary) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

function safeLimit(value, fallback = 20) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, 1), 50)
    : fallback;
}

function safeMcpError(error) {
  if (error?.code === -32601 || error?.code === -32602) {
    return { code: error.code, message: error.message };
  }
  if (
    SAFE_MCP_ERROR_NAMES.has(error?.name) ||
    SAFE_CONFIRMATION_ERROR_CODES.has(error?.code)
  ) {
    return {
      code: -32000,
      message: error.message,
      data: { code: error.code || "CAPABILITY_FAILED" },
    };
  }
  return {
    code: -32603,
    message: "SYNCHRON-X временно не може да изпълни заявката.",
  };
}

export function isValidMcpToken(header, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32)
    return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function createMcpRequestHandler({
  listMemories = listProfileMemories,
  listConversations = listConversationSummaries,
  listMessages = listConversationMessages,
  audit = recordAuditEvent,
  buildCleanupPlan = buildMergedBranchCleanupPlan,
  executeCleanup = executeMergedBranchCleanup,
  createConfirmation = createDurableConfirmation,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  getGoogleCloudStatus = getGoogleCloudRuntimeStatus,
  getSystemConfiguration = getSystemConfigurationReport,
  runAgentConversation = sendMcpAgentMessage,
  executeWrite = executeAuditedWriteAction,
} = {}) {
  const callCapabilityTool = createMcpCapabilityHandler({ audit });

  async function callTool(name, args, ownerId, identity) {
    const capabilityCall = await callCapabilityTool(name, args, {
      ownerId,
      identity,
    });
    if (capabilityCall.handled) return capabilityCall.result;

    let result;
    if (name === "get_personal_context") {
      const items = await listMemories({ scope: "personal", ownerId });
      result = textResult(
        { scope: "personal", items },
        `Прочетени са ${items.length} лични записа от AI CORE.`,
      );
    } else if (name === "get_project_context") {
      const items = await listMemories({ scope: "project", ownerId });
      result = textResult(
        { scope: "project", items },
        `Прочетени са ${items.length} проектни записа от AI CORE.`,
      );
    } else if (name === "list_synchron_conversations") {
      const items = await listConversations(safeLimit(args?.limit), ownerId);
      result = textResult(
        { items },
        `Намерени са ${items.length} разговора в AI CORE.`,
      );
    } else if (name === "get_synchron_conversation") {
      const sessionId =
        typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId || sessionId.length > 160) {
        throw Object.assign(new Error("Невалиден sessionId."), {
          code: -32602,
        });
      }
      const items = await listMessages(sessionId, undefined, ownerId);
      result = textResult(
        { sessionId, items },
        `Прочетени са ${items.length} съобщения от избрания разговор.`,
      );
    } else if (name === "talk_to_ai_core") {
      const conversation = await runAgentConversation({
        ownerId,
        message: args?.message,
        sessionId: args?.sessionId,
        projectId: args?.projectId,
        agentId: args?.agentId,
        identity,
      });
      result = textResult(conversation, conversation.response);
    } else if (name === "get_google_cloud_runtime_status") {
      const status = await getGoogleCloudStatus();
      result = textResult(status, formatGoogleCloudRuntimeStatus(status));
    } else if (name === "get_system_configuration") {
      const configuration = await getSystemConfiguration();
      result = textResult(
        configuration,
        formatSystemConfigurationReport(configuration),
      );
    } else if (name === "prepare_github_merged_branch_cleanup") {
      const plan = await buildCleanupPlan();
      const confirmation = await createConfirmation({
        sessionId: ownerId,
        action: "github.write:delete_merged_branches",
        resource: {
          repository: plan.repository,
          count: plan.count,
          fingerprint: plan.fingerprint,
        },
        params: { branchNames: plan.branchNames },
      });
      result = textResult(
        {
          ...plan,
          confirmationId: confirmation.id,
          expiresAt: new Date(confirmation.expiresAt).toISOString(),
        },
        `Намерени са ${plan.count} безопасни за изтриване клона. Нищо не е изтрито.`,
      );
    } else if (name === "confirm_github_merged_branch_cleanup") {
      const confirmationId =
        typeof args?.confirmationId === "string"
          ? args.confirmationId.trim()
          : "";
      if (!confirmationId) {
        throw Object.assign(new Error("Липсва confirmationId."), {
          code: -32602,
        });
      }
      const confirmation = await validateConfirmation(confirmationId, ownerId);
      if (confirmation.action !== "github.write:delete_merged_branches") {
        throw Object.assign(new Error("Невалидно потвърждение."), {
          code: -32602,
        });
      }
      await consumeConfirmation(confirmationId);
      const cleanup = await executeCleanup({
        repository: confirmation.resource.repository,
        branchNames: confirmation.params.branchNames,
        fingerprint: confirmation.resource.fingerprint,
      });
      result = textResult(
        cleanup,
        `Изтрити са ${cleanup.count} клона от вече слети Pull Request-и.`,
      );
    } else {
      throw Object.assign(new Error("Непознат MCP инструмент."), {
        code: -32601,
      });
    }

    await audit({
      actor: "chatgpt-mcp",
      action:
        name === "talk_to_ai_core"
          ? "agent.chat"
          : name.includes("github")
                ? "github.write"
                : name.includes("google_cloud") ||
                    name.includes("system_configuration")
                  ? "infrastructure.read"
                  : "memory.read",
      decision: "allow",
      outcome: "succeeded",
      resource: name,
      details:
        name === "talk_to_ai_core"
          ? "conversation-mcp"
          : name.startsWith("confirm_")
            ? "confirmed-write-mcp"
            : name.startsWith("prepare_")
              ? "write-plan-mcp"
              : "read-only-mcp",
    });
    return result;
  }

  return async function handleMcpRequest(message, ownerId, identity) {
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
              "Използвай само нужните за задачата права. Личният и проектният контекст са различни. Повечето инструменти са само за четене. Разговорът с AI CORE пази нишката, но не изпълнява външни действия. Всеки destructive инструмент подготвя отделен точен план и се изпълнява само след еднократно потвърждение. Merge, промяна на secrets и production deployment не са достъпни през този MCP.",
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
          identity,
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
        error: safeMcpError(error),
      };
    }
  };
}
