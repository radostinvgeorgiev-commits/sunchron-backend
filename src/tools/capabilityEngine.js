import { evaluatePermission } from "../services/permissionService.js";
import { answerGitHubReadRequest } from "../services/githubService.js";
import {
  GoogleDriveError,
  hasSession,
  listDriveFiles,
  listGmailMessages,
  listGoogleCalendarEvents,
} from "../services/googleDriveService.js";
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
import { prepareCopilotTask } from "../services/copilotTaskService.js";
import {
  isMergedBranchCleanupPlanRequest,
  prepareMergedBranchCleanup,
} from "../services/githubBranchCleanupService.js";
import { checkSupabaseStatus } from "../services/supabaseService.js";
import {
  formatDigitalOceanStatus,
  getDigitalOceanAppStatus,
} from "../services/digitalOceanService.js";
import {
  formatCloudflareStatus,
  getCloudflareZoneStatus,
} from "../services/cloudflareService.js";
import { findToolsByCapability, registerCoreTools } from "./toolRegistry.js";

export class CapabilityError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.status = status;
  }
}

function resolvePermission(tool, capability) {
  return tool.capabilityPermissions?.[capability] || null;
}

export function resolveCapability(capability, options = {}) {
  if (typeof capability !== "string" || !capability.trim()) {
    throw new CapabilityError(
      "Липсва заявена способност.",
      "MISSING_CAPABILITY",
    );
  }

  registerCoreTools();
  const candidates = findToolsByCapability(capability.trim());
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
  "github-read": async ({ input }) => {
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
  "digitalocean-read": async () =>
    formatDigitalOceanStatus(await getDigitalOceanAppStatus()),
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
  if (resolved.requiresConfirmation && options.confirmed !== true) {
    const canPrepareGitHubConfirmation =
      options.prepareConfirmation === true &&
      resolved.tool.id === "github-write";
    if (!canPrepareGitHubConfirmation) {
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

export function isToolExecutable(toolId) {
  return typeof executors[toolId] === "function";
}
