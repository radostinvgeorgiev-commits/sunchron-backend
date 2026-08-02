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
  activateDigitalOceanDomainAlias,
  DIGITALOCEAN_DOMAIN_ACTION,
  formatDigitalOceanAudit,
  formatDigitalOceanStatus,
  getDigitalOceanAccountAudit,
  getDigitalOceanAppStatus,
  inspectDigitalOceanDomainAlias,
  PUBLIC_WWW_DOMAIN,
} from "./digitalOceanService.js";
import {
  formatCloudflareStatus,
  getCloudflareZoneStatus,
} from "./cloudflareService.js";
import {
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "./systemConfigurationService.js";
import {
  formatCopilotTaskStatus,
  getCopilotTaskStatus,
} from "./copilotTaskService.js";
import { getLatestAuthorizedGitHubSession } from "./githubOAuthService.js";
import { mcpToolSecuritySchemes } from "./mcpOAuthService.js";

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

export const MCP_TOOLS = Object.freeze([
  {
    name: "get_personal_context",
    title: "Прочети личния контекст",
    description:
      "Прочита проверените лични факти за Радко от постоянната памет на SYNCHRON-X. Използвай само когато са нужни за текущия въпрос.",
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
      "Прочита проверените факти за NOVARIUM / SYNCHRON-X. Не ги смесвай с личните факти за Радко.",
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
    securitySchemes: mcpToolSecuritySchemes("list_synchron_conversations"),
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
    securitySchemes: mcpToolSecuritySchemes("get_synchron_conversation"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_digitalocean_app_status",
    title: "Провери DigitalOcean приложението",
    description:
      "Показва статуса на SYNCHRON-X в DigitalOcean App Platform и последните деплои. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_digitalocean_app_status"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_system_configuration",
    title: "Провери системната конфигурация",
    description:
      "Показва предназначението и състоянието на runtime и DigitalOcean променливите, ядрото и връзките, без стойности на ключове, пароли или token-и. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_system_configuration"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_digitalocean_account_audit",
    title: "Направи пълен DigitalOcean одит",
    description:
      "Проверява само за четене приложения, Droplets, бази, storage, мрежи, firewalls, домейни, разходи и последни действия. Не връща тайни и не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_digitalocean_account_audit"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "prepare_digitalocean_www_domain",
    title: "Подготви добавянето на www адреса",
    description:
      "Проверява DigitalOcean приложението и подготвя еднократно потвърждение само за www.synchron.foundation. Не променя домейни и не стартира deployment.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("prepare_digitalocean_www_domain"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "confirm_digitalocean_www_domain",
    title: "Потвърди добавянето на www адреса",
    description:
      "Добавя единствено www.synchron.foundation към предварително провереното DigitalOcean приложение след валидно еднократно потвърждение и устойчив журнал.",
    inputSchema: {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("confirm_digitalocean_www_domain"),
    annotations: DESTRUCTIVE_ANNOTATIONS,
  },
  {
    name: "get_cloudflare_zone_status",
    title: "Провери Cloudflare и DNS",
    description:
      "Показва статуса на Cloudflare зоната и DNS записите. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_cloudflare_zone_status"),
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_github_copilot_task_status",
    title: "Проследи GitHub Copilot задача",
    description:
      "Проверява реалното състояние на конкретна GitHub задача, свързания Pull Request, CI проверките и production smoke статуса. Не променя нищо.",
    inputSchema: {
      type: "object",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
      },
      required: ["issueNumber"],
      additionalProperties: false,
    },
    securitySchemes: mcpToolSecuritySchemes("get_github_copilot_task_status"),
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
  getDigitalOceanStatus = getDigitalOceanAppStatus,
  getDigitalOceanAudit = getDigitalOceanAccountAudit,
  inspectDigitalOceanDomain = inspectDigitalOceanDomainAlias,
  activateDigitalOceanDomain = activateDigitalOceanDomainAlias,
  getCloudflareStatus = getCloudflareZoneStatus,
  getSystemConfiguration = getSystemConfigurationReport,
  getLatestGitHubSession = getLatestAuthorizedGitHubSession,
  getGitHubTaskStatus = getCopilotTaskStatus,
  executeWrite = executeAuditedWriteAction,
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
        throw Object.assign(new Error("Невалиден sessionId."), {
          code: -32602,
        });
      }
      const items = await listMessages(sessionId, undefined, ownerId);
      result = textResult(
        { sessionId, items },
        `Прочетени са ${items.length} съобщения от избрания разговор.`,
      );
    } else if (name === "get_digitalocean_app_status") {
      const status = await getDigitalOceanStatus();
      result = textResult(status, formatDigitalOceanStatus(status));
    } else if (name === "get_digitalocean_account_audit") {
      const auditReport = await getDigitalOceanAudit();
      result = textResult(auditReport, formatDigitalOceanAudit(auditReport));
    } else if (name === "prepare_digitalocean_www_domain") {
      const status = await inspectDigitalOceanDomain({
        domain: PUBLIC_WWW_DOMAIN,
      });
      if (status.configured) {
        result = textResult(
          {
            configured: true,
            domain: status.domain,
            readAccessVerified: status.readAccessVerified,
          },
          `${status.domain} вече е конфигуриран в DigitalOcean.`,
        );
      } else {
        const confirmation = await createConfirmation({
          sessionId: ownerId,
          action: DIGITALOCEAN_DOMAIN_ACTION,
          resource: {
            appId: status.appId,
            domain: status.domain,
          },
          params: { domain: status.domain },
        });
        result = textResult(
          {
            configured: false,
            confirmationId: confirmation.id,
            expiresAt: new Date(confirmation.expiresAt).toISOString(),
            domain: status.domain,
            readAccessVerified: status.readAccessVerified,
            requiredWriteScope: status.requiredWriteScope,
          },
          `DigitalOcean проверката е успешна. Нужно е точно потвърждение за добавяне само на ${status.domain}.`,
        );
      }
    } else if (name === "confirm_digitalocean_www_domain") {
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
      if (
        confirmation.action !== DIGITALOCEAN_DOMAIN_ACTION ||
        confirmation.resource?.domain !== PUBLIC_WWW_DOMAIN
      ) {
        throw Object.assign(
          new Error("Потвърждението не е за www.synchron.foundation."),
          { code: -32602 },
        );
      }
      await consumeConfirmation(confirmationId);
      const activation = await executeWrite({
        action: DIGITALOCEAN_DOMAIN_ACTION,
        capability: "infrastructure.write",
        actor: "chatgpt-mcp",
        sessionId: ownerId,
        confirmationId,
        resource: confirmation.resource.domain,
        details: "add_www_domain_alias",
        execute: () =>
          activateDigitalOceanDomain({
            domain: confirmation.resource.domain,
            expectedAppId: confirmation.resource.appId,
          }),
      });
      result = textResult(
        activation,
        activation.updated
          ? `${activation.domain} е добавен и DigitalOcean стартира deployment.`
          : `${activation.domain} вече е конфигуриран; не е направена повторна промяна.`,
      );
    } else if (name === "get_system_configuration") {
      const configuration = await getSystemConfiguration();
      result = textResult(
        configuration,
        formatSystemConfigurationReport(configuration),
      );
    } else if (name === "get_cloudflare_zone_status") {
      const status = await getCloudflareStatus();
      result = textResult(status, formatCloudflareStatus(status));
    } else if (name === "get_github_copilot_task_status") {
      const issueNumber = Number(args?.issueNumber);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw Object.assign(new Error("Невалиден номер на GitHub задача."), {
          code: -32602,
        });
      }
      const githubSession = await getLatestGitHubSession();
      const status = await getGitHubTaskStatus({
        githubSession,
        issueNumber,
      });
      result = textResult(status, formatCopilotTaskStatus(status));
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
        name === "confirm_digitalocean_www_domain"
          ? DIGITALOCEAN_DOMAIN_ACTION
          : name === "get_github_copilot_task_status"
            ? "github.read"
            : name.includes("github")
              ? "github.write"
              : name.includes("digitalocean") ||
                  name.includes("cloudflare") ||
                  name.includes("system_configuration")
                ? "infrastructure.read"
                : "memory.read",
      decision: "allow",
      outcome: "succeeded",
      resource: name,
      details: name.startsWith("confirm_")
        ? "confirmed-write-mcp"
        : name.startsWith("prepare_")
          ? "write-plan-mcp"
          : "read-only-mcp",
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
              "Използвай паметта само когато е свързана с въпроса. Личният и проектният контекст са различни. Повечето инструменти са само за четене. Изтриването на слети GitHub клонове е отделен destructive инструмент и работи само след точен план, еднократно потвърждение и повторна проверка.",
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
