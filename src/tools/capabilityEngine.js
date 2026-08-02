import { evaluatePermission } from "../services/permissionService.js";
import { isCopilotAutomationEnabled } from "../config/featureFlags.js";
import { answerGitHubReadRequest } from "../services/githubService.js";
import {
  GoogleDriveError,
  hasSession,
  listDriveFiles,
  listGmailMessages,
  listGoogleCalendarEvents,
} from "../services/googleDriveService.js";
import { prepareCalendarEvent } from "../services/calendarService.js";
import {
  deleteProfileMemoryByFact,
  listProfileMemories,
  saveProfileMemory,
} from "../services/memoryService.js";
import {
  formatMemoryAcceptanceReport,
  runMemoryAcceptanceTest,
} from "../services/memoryAcceptanceService.js";
import {
  formatWebSearchResult,
  searchWeb,
} from "../services/webSearchService.js";
import {
  extractCopilotTaskNumber,
  formatCopilotTaskStatus,
  formatCopilotBridgeStatus,
  getCopilotTaskStatus,
  getCopilotBridgeStatus,
  isCopilotBridgeStatusRequest,
  prepareCopilotTask,
} from "../services/copilotTaskService.js";
import {
  isMergedBranchCleanupPlanRequest,
  prepareMergedBranchCleanup,
} from "../services/githubBranchCleanupService.js";
import { checkSupabaseStatus } from "../services/supabaseService.js";
import {
  formatDigitalOceanAudit,
  formatDigitalOceanOpenSearchBackupAudit,
  formatDigitalOceanStatus,
  getDigitalOceanAccountAudit,
  getDigitalOceanAppStatus,
  getDigitalOceanOpenSearchBackupAudit,
} from "../services/digitalOceanService.js";
import {
  formatCloudflareStatus,
  getCloudflareZoneStatus,
} from "../services/cloudflareService.js";
import {
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "../services/systemConfigurationService.js";
import {
  isCodexAgentConfigured,
  runCodexReadAnalysis,
} from "../services/codexAgentService.js";
import { findToolsByCapability, registerCoreTools } from "./toolRegistry.js";

export class CapabilityError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.status = status;
  }
}

export function isDigitalOceanBackupInventoryRequest(message = "") {
  return /(?:opensearch|open\s*search|опен\s*сърч|backup|backups|архив|restore\s*точ)/iu.test(
    message,
  );
}

function hasEnvironment(env, ...names) {
  return names.every(
    (name) => typeof env[name] === "string" && env[name].trim().length > 0,
  );
}

export function getToolRuntimeAvailability(
  toolId,
  input = {},
  env = process.env,
) {
  const configured = (available, reason, code = "CAPABILITY_NOT_CONFIGURED") =>
    Object.freeze({ available, reason, code });

  switch (toolId) {
    case "synchron-integrations-status":
    case "synchron-system-inspector":
    case "github-read":
      return configured(true, null);
    case "github-write":
      if (!isCopilotAutomationEnabled(env)) {
        return configured(
          false,
          "GitHub Write е изключен — режим без Copilot.",
          "COPILOT_AUTOMATION_DISABLED",
        );
      }
      if (!hasEnvironment(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")) {
        return configured(
          false,
          "GitHub Write не е конфигуриран.",
          "CAPABILITY_NOT_CONFIGURED",
        );
      }
      return configured(
        Boolean(input.githubSessionId),
        "GitHub Write изисква удостоверена собственическа сесия.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "google-drive-read":
    case "google-calendar-read":
    case "google-calendar-write":
    case "gmail-read":
      if (
        !hasEnvironment(
          env,
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "GOOGLE_REDIRECT_URI",
        )
      ) {
        return configured(
          false,
          "Google връзката не е конфигурирана.",
          "CAPABILITY_NOT_CONFIGURED",
        );
      }
      return configured(
        Boolean(input.googleSessionId),
        "Google инструментът изисква удостоверена Google сесия.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "openai-web-search":
      return configured(
        hasEnvironment(env, "OPENAI_API_KEY"),
        "OpenAI Web Search не е конфигуриран.",
      );
    case "openai-codex":
      return configured(
        isCodexAgentConfigured(env),
        "Codex агентът не е конфигуриран.",
        "CODEX_AGENT_NOT_CONFIGURED",
      );
    case "supabase-status":
      return configured(
        hasEnvironment(env, "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"),
        "Supabase Status не е конфигуриран.",
      );
    case "digitalocean-read":
      return configured(
        Boolean(
          (env.DIGITALOCEAN_API_TOKEN || env.DIGITALOCEAN_TOKEN) &&
          env.DIGITALOCEAN_APP_ID,
        ),
        "DigitalOcean Read не е конфигуриран.",
      );
    case "cloudflare-read":
      return configured(
        hasEnvironment(env, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"),
        "Cloudflare Read не е конфигуриран.",
      );
    case "opensearch-memory":
      return configured(
        hasEnvironment(
          env,
          "OPENSEARCH_HOST",
          "OPENSEARCH_PORT",
          "OPENSEARCH_USERNAME",
          "OPENSEARCH_PASSWORD",
        ),
        "Постоянната памет не е конфигурирана.",
      );
    default:
      return configured(false, "Инструментът няма runtime проверка.");
  }
}

function resolvePermission(tool, capability) {
  return tool.capabilityPermissions?.[capability] || null;
}

async function checkedStatus(check) {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

export async function buildIntegrationStatusReport(
  input = {},
  {
    checkGitHub = () =>
      answerGitHubReadRequest("Покажи последния commit в GitHub."),
    checkMemory = () =>
      listProfileMemories({ ownerId: input.ownerId, limit: 1 }),
    checkSupabase = checkSupabaseStatus,
    checkDigitalOcean = getDigitalOceanAppStatus,
    checkGoogleSession = hasSession,
    checkGitHubWriteBridge = getCopilotBridgeStatus,
    env = process.env,
  } = {},
) {
  const copilotAutomationEnabled = isCopilotAutomationEnabled(env);
  if (isCopilotBridgeStatusRequest(input.message)) {
    if (!copilotAutomationEnabled) {
      return [
        "Проверих текущия режим за GitHub Write.",
        "Резултат: изключен е — работим без Copilot.",
        "GitHub Read остава активен; кодовият мост не прави assignment, branch, commit или Pull Request.",
      ].join("\n");
    }
    const bridge = await checkGitHubWriteBridge({
      githubSessionId: input.githubSessionId,
    });
    return formatCopilotBridgeStatus(bridge);
  }

  const [githubRead, memory, supabase, digitalOcean, googleConnected] =
    await Promise.all([
      checkedStatus(checkGitHub),
      checkedStatus(checkMemory),
      checkedStatus(checkSupabase),
      checkedStatus(checkDigitalOcean),
      input.googleSessionId
        ? checkedStatus(() => checkGoogleSession(input.googleSessionId))
        : false,
    ]);

  const working = [
    ["GitHub Read", githubRead],
    ["Synchron Memory", memory],
    ["Supabase Status", supabase],
    ["DigitalOcean Read", digitalOcean],
    ["OpenAI разговор", Boolean(env.OPENAI_API_KEY)],
    ["OpenAI Web Search", Boolean(env.OPENAI_API_KEY)],
    ["Codex", isCodexAgentConfigured(env)],
  ];
  const sessionTools = [
    [
      "GitHub Write",
      copilotAutomationEnabled && Boolean(input.githubSessionId),
      copilotAutomationEnabled
        ? "изисква потвърждение"
        : "изключен — режим без Copilot",
    ],
    ["Google Drive", googleConnected, "изисква Google вход"],
    ["Google Calendar", googleConnected, "изисква Google вход"],
    ["Gmail", googleConnected, "изисква Google вход"],
    [
      "Cloudflare Read",
      Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID),
      "липсват Cloudflare настройки",
    ],
  ];

  return [
    "Проверих инструментите реално сега.",
    "",
    "Работят:",
    ...working
      .filter(([, available]) => available)
      .map(([name]) => `• ${name}`),
    "",
    "Състояние на останалите връзки:",
    ...sessionTools
      .filter(([, available]) => !available)
      .map(([name, , reason]) => `• ${name} — ${reason}`),
    ...working
      .filter(([, available]) => !available)
      .map(([name]) => `• ${name} — реалната проверка е неуспешна`),
    ...sessionTools
      .filter(([, available]) => available)
      .map(([name, , note]) => `• ${name} — свързан; ${note}`),
  ].join("\n");
}

export function resolveCapability(capability, options = {}) {
  if (typeof capability !== "string" || !capability.trim()) {
    throw new CapabilityError(
      "Липсва заявена способност.",
      "MISSING_CAPABILITY",
    );
  }

  registerCoreTools();
  const candidates = findToolsByCapability(capability.trim(), {
    healthyOnly: false,
  });
  if (!candidates.length) {
    throw new CapabilityError(
      `Няма активен инструмент за "${capability.trim()}".`,
      "CAPABILITY_UNAVAILABLE",
      503,
    );
  }

  const preferredProvider =
    typeof options.preferredProvider === "string"
      ? options.preferredProvider.trim()
      : "";
  const tool =
    candidates.find((candidate) => candidate.provider === preferredProvider) ||
    candidates[0];
  const permissionName = resolvePermission(tool, capability.trim());
  const permission = permissionName
    ? evaluatePermission(permissionName)
    : {
        action: "unknown",
        decision: "deny",
        risk: "unknown",
        reason: "Инструментът няма декларирано разрешение.",
      };

  if (permission.decision === "deny") {
    throw new CapabilityError(
      permission.reason,
      "CAPABILITY_PERMISSION_DENIED",
      403,
    );
  }

  return Object.freeze({
    capability: capability.trim(),
    tool,
    permission,
    requiresConfirmation:
      tool.requiresConfirmation || permission.decision === "confirm",
  });
}

const executors = Object.freeze({
  "synchron-integrations-status": async ({ input }) =>
    buildIntegrationStatusReport(input),
  "synchron-system-inspector": async () =>
    formatSystemConfigurationReport(await getSystemConfigurationReport()),
  "github-read": async ({ capability, input }) => {
    if (capability === "code.task-status") {
      const issueNumber = extractCopilotTaskNumber(input.message);
      if (!issueNumber) {
        throw new CapabilityError(
          "Липсва номер на GitHub задача за проследяване.",
          "MISSING_ISSUE_NUMBER",
        );
      }
      return formatCopilotTaskStatus(
        await getCopilotTaskStatus({
          githubSessionId: input.githubSessionId,
          issueNumber,
        }),
      );
    }
    if (isMergedBranchCleanupPlanRequest(input.message)) {
      return prepareMergedBranchCleanup({ ownerId: input.ownerId });
    }
    return answerGitHubReadRequest(input.message);
  },
  "github-write": async ({ input }) => {
    const prepared = await prepareCopilotTask({
      sessionId: input.sessionId,
      githubSessionId: input.githubSessionId,
      prompt: input.message,
    });
    return prepared.output;
  },
  "openai-codex": async ({ input }) =>
    runCodexReadAnalysis({
      message: input.message,
      projectName: input.workContext?.project?.name,
      projectObjective: input.workContext?.project?.objective,
      model:
        input.workContext?.agent?.model === "auto"
          ? undefined
          : input.workContext?.agent?.model,
    }),
  "google-calendar-read": async ({ input }) => {
    if (!(await hasSession(input.googleSessionId))) {
      throw new GoogleDriveError(
        "Google Calendar не е свързан. [Свържи Google](https://synchron.foundation/api/google/connect).",
        401,
        "NOT_CONNECTED",
      );
    }
    const events = await listGoogleCalendarEvents(input.googleSessionId);
    if (!events.length) return "Няма предстоящи събития в Google Calendar.";
    return [
      "Предстоящи събития:",
      ...events.map(
        (event) =>
          `• ${event.title} — ${event.start || "без посочен начален час"}`,
      ),
    ].join("\n");
  },
  "google-calendar-write": async ({ input }) => {
    const prepared = await prepareCalendarEvent({
      sessionId: input.sessionId,
      googleSessionId: input.googleSessionId,
      message: input.message,
    });
    return prepared.output;
  },
  "google-drive-read": async ({ input }) => {
    const files = await listDriveFiles(input.googleSessionId);
    if (!files.length) return "Няма намерени файлове в Google Drive.";
    return [
      "Последни файлове в Google Drive:",
      ...files.slice(0, 15).map((file) => `• ${file.name}`),
    ].join("\n");
  },
  "gmail-read": async ({ input }) => {
    const messages = await listGmailMessages(input.googleSessionId, 10);
    if (!messages.length) return "Няма намерени съобщения в Gmail.";
    return [
      "Последни съобщения в Gmail:",
      ...messages.map(
        (message) =>
          `• ${message.unread ? "Непрочетено — " : ""}${message.subject} — ${message.from}`,
      ),
    ].join("\n");
  },
  "openai-web-search": async ({ input }) =>
    formatWebSearchResult(await searchWeb(input.message)),
  "supabase-status": async () => {
    const status = await checkSupabaseStatus();
    return [
      "Supabase е свързан и отговаря.",
      `Услуга: ${status.service}.`,
      `Време за отговор: ${status.responseTimeMs} ms.`,
      "OpenSearch остава постоянната AI памет.",
    ].join("\n");
  },
  "digitalocean-read": async ({ input }) => {
    if (isDigitalOceanBackupInventoryRequest(input.message)) {
      return formatDigitalOceanOpenSearchBackupAudit(
        await getDigitalOceanOpenSearchBackupAudit(),
      );
    }
    const wantsFullAudit =
      /(?:пълен|цял|одит|акаунт|ресурс|droplet|сървър|баз|мреж|firewall|защит|разход|billing|storage|volume|snapshot|kubernetes)/iu.test(
        input.message || "",
      );
    return wantsFullAudit
      ? formatDigitalOceanAudit(await getDigitalOceanAccountAudit())
      : formatDigitalOceanStatus(await getDigitalOceanAppStatus());
  },
  "cloudflare-read": async () =>
    formatCloudflareStatus(await getCloudflareZoneStatus()),
  "opensearch-memory": async ({ capability, input }) => {
    if (capability === "memory.verify") {
      const report = await runMemoryAcceptanceTest({
        ownerId: input.ownerId,
        verifyDeleteGuard: async ({ fact, scope, ownerId }) => {
          try {
            await executeCapability(
              "memory.delete",
              { fact, scope, ownerId },
              { confirmed: false },
            );
          } catch (error) {
            if (error?.code === "CAPABILITY_CONFIRMATION_REQUIRED") return true;
            throw error;
          }
          return false;
        },
      });
      return formatMemoryAcceptanceReport(report);
    }
    if (capability === "memory.read" || capability === "memory.search") {
      const memories = await listProfileMemories({
        scope: input.scope,
        ownerId: input.ownerId,
      });
      if (!memories.length) return "Постоянната памет е празна.";
      const visibleMemories = memories.slice(0, 8);
      const hiddenCount = memories.length - visibleMemories.length;
      const heading =
        input.scope === "project"
          ? "Проектна памет:"
          : input.scope === "personal"
            ? "Лична памет:"
            : "Постоянна памет:";
      return [
        heading,
        ...visibleMemories.map(({ fact }) => `• ${fact}`),
        ...(hiddenCount > 0
          ? [`• Още ${hiddenCount} свързани записа не са показани.`]
          : []),
      ].join("\n");
    }
    if (capability === "memory.save" || capability === "memory.update") {
      if (!input.fact) {
        throw new CapabilityError(
          "Липсва факт за запис в паметта.",
          "MISSING_MEMORY_FACT",
        );
      }
      const saved = await saveProfileMemory(
        input.fact,
        "capability-engine",
        input.scope,
        input.ownerId,
      );
      return saved.replaced
        ? `Обнових постоянната памет: ${saved.fact}.`
        : `Записах в постоянната памет: ${saved.fact}.`;
    }
    if (capability === "memory.delete") {
      if (!input.fact) {
        throw new CapabilityError(
          "Липсва факт за изтриване от паметта.",
          "MISSING_MEMORY_FACT",
        );
      }
      const deleted = await deleteProfileMemoryByFact(
        input.fact,
        input.scope,
        input.ownerId,
      );
      return deleted
        ? `Изтрих от постоянната памет: ${input.fact}.`
        : "Не намерих такъв запис в постоянната памет.";
    }
    return null;
  },
});

export async function executeCapability(capability, input = {}, options = {}) {
  const resolved = resolveCapability(capability, options);
  const runtimeEnvironment = options.env || process.env;
  if (
    resolved.tool.id === "github-write" &&
    !isCopilotAutomationEnabled(runtimeEnvironment)
  ) {
    const runtime = getToolRuntimeAvailability(
      resolved.tool.id,
      input,
      runtimeEnvironment,
    );
    throw new CapabilityError(runtime.reason, runtime.code, 503);
  }

  if (resolved.requiresConfirmation && options.confirmed !== true) {
    const canPrepareConfirmation =
      options.prepareConfirmation === true &&
      ["github-write", "google-calendar-write"].includes(resolved.tool.id);
    if (!canPrepareConfirmation) {
      throw new CapabilityError(
        `Способността "${capability}" изисква потвърждение.`,
        "CAPABILITY_CONFIRMATION_REQUIRED",
        409,
      );
    }
  }

  const executor = executors[resolved.tool.id];
  if (!executor) {
    throw new CapabilityError(
      `Инструментът "${resolved.tool.name}" още няма изпълнима връзка.`,
      "CAPABILITY_NOT_EXECUTABLE",
      503,
    );
  }

  const runtime = getToolRuntimeAvailability(
    resolved.tool.id,
    input,
    runtimeEnvironment,
  );
  if (!runtime.available) {
    throw new CapabilityError(runtime.reason, runtime.code, 503);
  }

  const output = await executor({
    capability: resolved.capability,
    input,
    confirmed: options.confirmed === true,
  });
  if (typeof output !== "string" || !output.trim()) {
    throw new CapabilityError(
      `Инструментът "${resolved.tool.name}" не върна валиден резултат.`,
      "CAPABILITY_EMPTY_RESULT",
      502,
    );
  }

  return Object.freeze({ ...resolved, output });
}

export function isToolExecutable(toolId, env = process.env) {
  if (toolId === "github-write" && !isCopilotAutomationEnabled(env)) {
    return false;
  }
  return typeof executors[toolId] === "function";
}
