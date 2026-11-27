import {
  evaluatePermission,
  listAuditEvents,
} from "../services/permissionService.js";
import {
  isMemoryBackendConfigured,
  isPersistenceBackendConfigured,
} from "../config/memoryBackend.js";
import {
  getAiProviderStatus,
  hasConfiguredAiProvider,
  isAiCoreConfigured,
} from "../services/aiCoreService.js";
import { answerGitHubReadRequest } from "../services/githubService.js";
import { useEnglishReplyFallback } from "../config/replyLanguage.js";
import {
  formatAiProviderProbe,
  probeAiProviders,
} from "../services/aiProviderProbeService.js";
import {
  createGmailDraft,
  GoogleDriveError,
  hasSession,
  listDriveFiles,
  listGmailMessages,
  listGoogleCalendarEvents,
  searchGmailMessages,
  searchGoogleContacts,
  getYoutubeChannelSummary,
} from "../services/googleDriveService.js";
import {
  confirmCalendarEvent,
  prepareCalendarEvent,
} from "../services/calendarService.js";
import {
  confirmGoogleAction,
  prepareGmailDraftSend,
  prepareGmailMessageSend,
  prepareGmailMessageTrash,
  prepareGoogleContactChange,
} from "../services/googleActionService.js";
import {
  deleteProfileMemoryByFact,
  listConversationMessages,
  listConversationSummaries,
  listProfileMemories,
  saveProfileMemory,
} from "../services/memoryService.js";
import {
  addTaskNote,
  confirmTaskStatusChange,
  createTaskDraft,
  linkTaskToProject,
  listTasks,
  prepareTaskStatusChange,
} from "../services/taskManagementService.js";
import {
  formatMemoryAcceptanceReport,
  runMemoryAcceptanceTest,
} from "../services/memoryAcceptanceService.js";
import {
  formatWebSearchResult,
  searchWeb,
} from "../services/webSearchService.js";
import {
  askGoogleMaps,
  formatGeminiToolResult,
  summarizeYoutubeVideo,
} from "../services/geminiToolsService.js";
import {
  isCodeTaskConfigured,
  prepareCodeTask,
} from "../services/codeTaskService.js";
import {
  isMergedBranchCleanupPlanRequest,
  prepareMergedBranchCleanup,
} from "../services/githubBranchCleanupService.js";
import {
  confirmGitHubChange,
  prepareGitHubChange,
} from "../services/githubActionService.js";
import {
  getGitHubSession,
  isActiveAuthorizedGitHubSession,
} from "../services/githubOAuthService.js";
import {
  formatGoogleCloudRuntimeStatus,
  getGoogleCloudRuntimeStatus,
} from "../services/googleCloudService.js";
import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "../services/googleCloudActionService.js";
import {
  formatProjectDiagnostics,
  getProjectDiagnostics,
} from "../services/projectDiagnosticsService.js";
import {
  formatSystemConfigurationReport,
  getSystemConfigurationReport,
} from "../services/systemConfigurationService.js";
import {
  isCodexAgentConfigured,
  runCodexProjectAnalysis,
} from "../services/codexAgentService.js";
import {
  findToolsByCapability,
  listTools,
  registerCoreTools,
} from "./toolRegistry.js";

export class CapabilityError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.status = status;
  }
}

function hasEnvironment(env, ...names) {
  return names.every(
    (name) => typeof env[name] === "string" && env[name].trim().length > 0,
  );
}

async function resolveGitHubReadOptions(input = {}) {
  const sessionId =
    typeof input.githubSessionId === "string"
      ? input.githubSessionId.trim()
      : "";
  if (sessionId) {
    const session = await getGitHubSession(sessionId);
    if (!session) {
      throw new CapabilityError(
        "GitHub OAuth сесията е невалидна или изтекла.",
        "GITHUB_SESSION_INVALID",
        401,
      );
    }
    return { accessToken: session.accessToken };
  }

  if (input.githubSession) {
    if (!isActiveAuthorizedGitHubSession(input.githubSession)) {
      throw new CapabilityError(
        "Липсва активна собственическа GitHub сесия.",
        "GITHUB_SESSION_INVALID",
        401,
      );
    }
    return { accessToken: input.githubSession.accessToken };
  }

  return {};
}

export function getToolRuntimeAvailability(
  toolId,
  input = {},
  env = process.env,
) {
  // The reason explains what is missing, so it is only reported when the tool
  // is not available; an available tool never carries a "not configured" text.
  const configured = (available, reason, code = "CAPABILITY_NOT_CONFIGURED") =>
    Object.freeze(
      available
        ? { available: true, reason: null, code: null }
        : { available: false, reason, code },
    );

  switch (toolId) {
    case "synchron-agent-chat":
      if (!hasConfiguredAiProvider(env) || !isMemoryBackendConfigured(env)) {
        return configured(
          false,
          "AI CORE разговорът или постоянната история не са конфигурирани.",
        );
      }
      return configured(
        Boolean(input.ownerId),
        "AI CORE разговорът изисква проверен профил.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "synchron-integrations-status":
    case "synchron-system-inspector":
    case "github-read":
      return configured(true, null);
    case "github-write":
      if (
        !isCodeTaskConfigured(env) ||
        !hasEnvironment(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")
      ) {
        return configured(
          false,
          "AI CORE Code Write не е конфигуриран.",
          "CAPABILITY_NOT_CONFIGURED",
        );
      }
      return configured(
        Boolean(input.githubSessionId || input.githubSession),
        "GitHub Write изисква удостоверена собственическа сесия.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "github-confirmed-write":
      if (!hasEnvironment(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")) {
        return configured(
          false,
          "Потвърждаваният GitHub запис не е конфигуриран.",
        );
      }
      return configured(
        Boolean(input.githubSessionId || input.githubSession),
        "GitHub записът изисква удостоверена собственическа сесия.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "google-drive-read":
    case "google-calendar-read":
    case "google-calendar-write":
    case "gmail-read":
    case "google-contacts":
    case "youtube-channel":
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
    case "synchron-tasks":
      if (!isPersistenceBackendConfigured(env)) {
        return configured(false, "Задачите не са конфигурирани.");
      }
      return configured(
        Boolean(input.ownerId),
        "Задачите изискват проверен профил.",
        "CAPABILITY_AUTH_REQUIRED",
      );
    case "gemini-youtube":
    case "gemini-maps":
      return configured(
        hasEnvironment(env, "GEMINI_API_KEY"),
        "Gemini не е конфигуриран.",
      );
    case "openai-web-search":
      return configured(
        hasEnvironment(env, "OPENAI_API_KEY"),
        "OpenAI Web Search не е конфигуриран.",
      );
    case "openai-codex":
      return configured(
        isCodexAgentConfigured(env),
        "Кодовият агент (Claude) не е конфигуриран.",
        "CODEX_AGENT_NOT_CONFIGURED",
      );
    case "google-firestore-memory":
      return configured(
        isMemoryBackendConfigured(env),
        "Google Cloud Memory не е конфигурирана.",
      );
    case "google-cloud-read":
    case "google-cloud-diagnostics":
      return configured(
        Boolean(
          env.GOOGLE_CLOUD_PROJECT ||
          env.GCLOUD_PROJECT ||
          env.GCP_PROJECT_ID ||
          (env.K_SERVICE && env.K_REVISION),
        ),
        "Google Cloud runtime не е конфигуриран.",
      );
    case "google-cloud-write":
      return configured(
        Boolean(
          env.GOOGLE_CLOUD_PROJECT ||
          env.GCLOUD_PROJECT ||
          env.GCP_PROJECT_ID ||
          (env.K_SERVICE && env.K_REVISION),
        ),
        "Google Cloud write runtime не е конфигуриран.",
      );
    case "google-firestore-memory":
      return configured(
        isMemoryBackendConfigured(env),
        "Постоянната памет не е конфигурирана.",
      );
    default:
      return configured(false, "Инструментът няма runtime проверка.");
  }
}

function resolvePermission(tool, capability) {
  return tool.capabilityPermissions?.[capability] || null;
}

async function checkedStatus(check, isWorking = () => true) {
  try {
    const result = await check();
    return isWorking(result) === true;
  } catch {
    return false;
  }
}

export async function buildIntegrationStatusReport(
  input = {},
  {
    checkGitHub = () =>
      answerGitHubReadRequest(
        "Покажи последния commit в GitHub.",
        resolveGitHubReadOptions(input),
      ),
    checkMemory = () =>
      listProfileMemories({ ownerId: input.ownerId, limit: 1 }),
    checkGoogleCloud = getGoogleCloudRuntimeStatus,
    checkGoogleSession = hasSession,
    probeProviders = probeAiProviders,
    env = process.env,
  } = {},
) {
  if (isGitHubWriteStatusRequest(input.message)) {
    return [
      "Проверих текущия режим за GitHub Write.",
      "Резултат: AI CORE подготвя diff, а реалният запис се изпълнява чрез свързания GitHub Write API.",
      "След точно потвърждение създава отделен branch, атомарен commit и Pull Request; main не се променя директно.",
    ].join("\n");
  }

  const [githubRead, memory, googleCloud, googleConnected, providerProbe] = await Promise.all([
    checkedStatus(checkGitHub),
    checkedStatus(checkMemory),
    checkedStatus(checkGoogleCloud, (status) => status?.configured === true),
    input.googleSessionId
      ? checkedStatus(() => checkGoogleSession(input.googleSessionId))
      : false,
    probeProviders({ env }).catch(() => []),
  ]);
  const openAiWorks = providerProbe.some(
    ({ id, working }) => id === "openai" && working,
  );
  const claudeWorks = providerProbe.some(
    ({ id, working }) => id === "claude" && working,
  );

  const working = [
    ["GitHub Read", githubRead],
    ["Google Cloud Memory", memory],
    ["Google Cloud Read", googleCloud],
    [
      "AI CORE разговор",
      isAiCoreConfigured(env) &&
        providerProbe.some(
          ({ id, working }) =>
            id === getAiProviderStatus(env).primaryProvider && working,
        ),
    ],
    ["OpenAI Web Search", Boolean(env.OPENAI_API_KEY) && openAiWorks],
    ["Claude код", isCodexAgentConfigured(env) && claudeWorks],
  ];
  const sessionTools = [
    [
      "GitHub Write",
      Boolean(input.githubSessionId) &&
        isCodeTaskConfigured(env) &&
        hasEnvironment(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
      "изисква потвърждение",
    ],
    [
      "Google Cloud Write",
      Boolean(
        env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT_ID,
      ),
      "изисква потвърждение",
    ],
    ["Google Drive", googleConnected, "изисква Google вход"],
    ["Google Calendar", googleConnected, "изисква Google вход"],
    ["Gmail", googleConnected, "изисква Google вход"],
  ];
  const aiProviderStatus = getAiProviderStatus(env);

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
    "",
    "AI доставчици (реална заявка, кеш 10 мин):",
    ...formatAiProviderProbe(providerProbe, aiProviderStatus.primaryProvider),
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

function requiredInput(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CapabilityError(`Липсва ${label}.`, "MISSING_CAPABILITY_INPUT");
  }
  return value.trim();
}

function extractPullRequestNumber(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!/(?:merge|сли(?:й|ване)|сл(?:ей|ив)|обедин)/iu.test(text)) return null;
  const match = text.match(
    /#\s*(\d{1,10})|(?:pull\s*request|\bpr\b|пул\s*рек)\s*(?:№|номер)?\s*(\d{1,10})|(?:merge|сли(?:й|ване)|сл(?:ей|ив)|обедин)\s+#?\s*(\d{1,10})/iu,
  );
  const value = Number(match?.[1] || match?.[2] || match?.[3]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function confirmationOutput(prepared, label, exactCommand = null) {
  const lines = [
    `${label} е подготвено, но не е изпълнено.`,
    `Потвърждение: ${prepared.confirmationId}.`,
    `Валидно до: ${new Date(prepared.expiresAt).toISOString()}.`,
  ];
  if (exactCommand) lines.push(`За изпълнение изпрати точно: ${exactCommand}`);
  return lines.join("\n");
}

const executors = Object.freeze({
  "synchron-agent-chat": async ({ capability, input }) => {
    if (capability === "chat.list_threads") {
      const threads = await listConversationSummaries(20, input.ownerId);
      if (!threads.length) return "Няма запазени разговори в SYNCHRON-X.";
      return [
        "Разговори в SYNCHRON-X:",
        ...threads.map(
          (thread) =>
            `• ${thread.title} — ${thread.sessionId} — ${thread.messageCount} съобщения`,
        ),
      ].join("\n");
    }
    if (
      capability === "chat.read_history" ||
      capability === "chat.read_reply"
    ) {
      const sessionId = requiredInput(input.sessionId, "sessionId");
      const messages = await listConversationMessages(
        sessionId,
        undefined,
        input.ownerId,
      );
      if (capability === "chat.read_reply") {
        const reply = messages.findLast((item) => item.role === "assistant");
        return reply?.content || "В тази нишка още няма отговор от AI CORE.";
      }
      if (!messages.length) return "Избраният разговор е празен.";
      return messages
        .map(
          (item) =>
            `${item.role === "user" ? "Радко" : "AI CORE"}: ${item.content}`,
        )
        .join("\n\n");
    }
    const { sendMcpAgentMessage } =
      await import("../services/mcpAgentConversationService.js");
    const conversation = await sendMcpAgentMessage({
      ownerId: input.ownerId,
      message: input.message,
      sessionId:
        capability === "chat.continue_session" ? input.sessionId : undefined,
      projectId: input.projectId,
      agentId: input.agentId,
      identity: input.identity,
    });
    return conversation.response;
  },
  "synchron-integrations-status": async ({ capability, input }) => {
    if (capability === "system.tools.read") {
      registerCoreTools();
      return [
        "Регистрирани инструменти:",
        ...listTools().map(
          (tool) =>
            `• ${tool.name}: ${tool.capabilities.join(", ")} — ${tool.permissions.join(", ")}`,
        ),
      ].join("\n");
    }
    if (
      capability === "system.audit.read" ||
      capability === "system.errors.read"
    ) {
      const errorsOnly = capability === "system.errors.read";
      const events = (await listAuditEvents(errorsOnly ? 100 : 30))
        .filter((event) =>
          errorsOnly
            ? ["failed", "blocked", "uncertain"].includes(event.outcome)
            : true,
        )
        .slice(0, errorsOnly ? 20 : 30);
      if (!events.length) {
        return errorsOnly
          ? "Няма записани безопасни грешки."
          : "Журналът на действията е празен.";
      }
      return [
        errorsOnly ? "Последни безопасни грешки:" : "История на действията:",
        ...events.map(
          (event) =>
            `• ${event.timestamp || "без дата"} — ${event.action || "unknown"} — ${event.outcome || "unknown"}`,
        ),
      ].join("\n");
    }
    return buildIntegrationStatusReport(input);
  },
  "synchron-system-inspector": async () =>
    formatSystemConfigurationReport(await getSystemConfigurationReport()),
  "github-read": async ({ capability, input }) => {
    const readOptions = await resolveGitHubReadOptions(input);
    if (capability === "code.task-status") {
      const issueNumber = extractGitHubTaskNumber(input.message);
      if (!issueNumber) {
        throw new CapabilityError(
          "Липсва номер на GitHub задача за проследяване.",
          "MISSING_ISSUE_NUMBER",
        );
      }
      return answerGitHubReadRequest(input.message, readOptions);
    }
    if (isMergedBranchCleanupPlanRequest(input.message)) {
      return prepareMergedBranchCleanup({ ownerId: input.ownerId });
    }
    return answerGitHubReadRequest(input.message, readOptions);
  },
  "github-write": async ({ input }) => {
    const prepared = await prepareCodeTask({
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      githubSessionId: input.githubSessionId,
      githubSession: input.githubSession,
      message: input.message,
    });
    return {
      output: prepared.output,
      metadata: {
        confirmationId: prepared.confirmationId,
        confirmationType: "code-task",
      },
    };
  },
  "github-confirmed-write": async ({ capability, input, confirmed }) => {
    const githubSession =
      input.githubSession || (await getGitHubSession(input.githubSessionId));
    if (confirmed) {
      const changed = await confirmGitHubChange({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        confirmationId: requiredInput(input.confirmationId, "confirmationId"),
        githubSession,
      });
      return `Потвърдената GitHub промяна е изпълнена: ${changed.url || changed.sha || changed.number || "готово"}.`;
    }
    const operations = {
      "github.branch.create": "create_branch",
      "github.file.create": "create_file",
      "github.file.update": "update_file",
      "github.pull-request.create": "create_pr",
      "github.pull-request.merge": "merge_pr",
      "github.issue.close": "close_issue",
    };
    let changeInput = input.change || input;
    if (capability === "github.pull-request.merge") {
      const pullNumber = Number(
        changeInput.pullNumber || extractPullRequestNumber(input.message),
      );
      if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
        throw new CapabilityError(
          "Липсва номер на Pull Request за сливане.",
          "MISSING_PULL_REQUEST_NUMBER",
        );
      }
      changeInput = { ...changeInput, pullNumber };
    }
    const prepared = await prepareGitHubChange({
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      githubSession,
      operation: operations[capability],
      input: changeInput,
    });
    return {
      output: confirmationOutput(
        prepared,
        "GitHub промяната",
        `Потвърждавам GitHub промяната: ${prepared.confirmationId}`,
      ),
      metadata: {
        confirmationId: prepared.confirmationId,
        confirmationType: "capability",
      },
    };
  },
  "openai-codex": async ({ input }) => {
    const result = await runCodexProjectAnalysis({
      message: input.message,
      projectId: input.workContext?.project?.id,
      projectName: input.workContext?.project?.name,
      projectObjective: input.workContext?.project?.objective,
      previousRun: input.workContext?.project?.run,
      model:
        input.workContext?.agent?.model === "auto"
          ? undefined
          : input.workContext?.agent?.model,
    });
    return {
      output: result.output,
      metadata: Object.freeze({ projectRun: result.projectRun }),
    };
  },
  "google-calendar-read": async ({ input }) => {
    if (!(await hasSession(input.googleSessionId))) {
      throw new GoogleDriveError(
        "Google Calendar не е свързан. [Свържи Google](https://cloudaicore.com/api/google/connect).",
        401,
        "NOT_CONNECTED",
      );
    }
    const events = await listGoogleCalendarEvents(input.googleSessionId);
    const english = useEnglishReplyFallback(input.language);
    if (!events.length) {
      return english
        ? "No upcoming events in Google Calendar."
        : "Няма предстоящи събития в Google Calendar.";
    }
    return [
      english ? "Upcoming events:" : "Предстоящи събития:",
      ...events.map(
        (event) =>
          `• ${event.title} — ${event.start || (english ? "no start time" : "без посочен начален час")}`,
      ),
    ].join("\n");
  },
  "google-calendar-write": async ({ input, confirmed }) => {
    if (confirmed) {
      const event = await confirmCalendarEvent({
        confirmationId: requiredInput(input.confirmationId, "confirmationId"),
        sessionId: input.sessionId,
        googleSessionId: input.googleSessionId,
      });
      return useEnglishReplyFallback(input.language)
        ? `Calendar event created: ${event.title}.`
        : `Календарното събитие е създадено: ${event.title}.`;
    }
    const prepared = await prepareCalendarEvent({
      sessionId: input.sessionId,
      googleSessionId: input.googleSessionId,
      message: input.message,
    });
    const { draft } = prepared;
    const when = `${String(draft?.start || "").replace("T", " ")} (${draft?.timeZone || ""})`;
    return {
      output: prepared.output,
      metadata: {
        confirmationId: prepared.confirmationId,
        confirmationType: "capability",
        summary: useEnglishReplyFallback(input.language)
          ? `Create the Google Calendar event "${draft?.title}": ${when}, ${draft?.durationMinutes} min.`
          : `Създаване на събитие „${draft?.title}“ в Google Calendar: ${when}, ${draft?.durationMinutes} мин.`,
      },
    };
  },
  "google-drive-read": async ({ input }) => {
    const files = await listDriveFiles(input.googleSessionId);
    if (!files.length) return "Няма намерени файлове в Google Drive.";
    return [
      "Последни файлове в Google Drive:",
      ...files.slice(0, 15).map((file) => `• ${file.name}`),
    ].join("\n");
  },
  "gmail-read": async ({ capability, input, confirmed }) => {
    if (capability === "mail.draft") {
      const draft = await createGmailDraft(input.googleSessionId, {
        to: input.to,
        subject: input.subject,
        body: input.body || input.message,
      });
      return `Създадена е Gmail чернова до ${draft.to}. Нищо не е изпратено.`;
    }
    if (capability === "mail.send" || capability === "mail.delete") {
      if (confirmed) {
        const changed = await confirmGoogleAction({
          ownerId: input.ownerId,
          googleSessionId: input.googleSessionId,
          sessionId: input.sessionId,
          confirmationId: requiredInput(input.confirmationId, "confirmationId"),
        });
        if (useEnglishReplyFallback(input.language)) {
          return capability === "mail.send"
            ? changed.to
              ? `Email sent to ${changed.to}.`
              : `Gmail draft sent: ${changed.id}.`
            : `Gmail message moved to Trash: ${changed.id}.`;
        }
        return capability === "mail.send"
          ? changed.to
            ? `Имейлът е изпратен до ${changed.to}.`
            : `Gmail черновата е изпратена: ${changed.id}.`
          : `Gmail съобщението е преместено в кошчето: ${changed.id}.`;
      }
      const mail = input.input || input;
      if (capability === "mail.send" && !input.draftId && mail.to) {
        const prepared = await prepareGmailMessageSend({
          ownerId: input.ownerId,
          googleSessionId: input.googleSessionId,
          sessionId: input.sessionId,
          to: mail.to,
          subject: mail.subject,
          body: mail.body,
        });
        return {
          output: confirmationOutput(
            prepared,
            `Изпращането на имейл до ${prepared.message.to} (тема: ${prepared.message.subject || "без тема"})`,
          ),
          metadata: {
            confirmationId: prepared.confirmationId,
            confirmationType: "capability",
            summary: useEnglishReplyFallback(input.language)
              ? `Send an email to ${prepared.message.to} (subject: ${prepared.message.subject || "no subject"}).`
              : `Изпращане на имейл до ${prepared.message.to} (тема: ${prepared.message.subject || "без тема"}).`,
          },
        };
      }
      const prepared =
        capability === "mail.send"
          ? await prepareGmailDraftSend({
              ownerId: input.ownerId,
              googleSessionId: input.googleSessionId,
              sessionId: input.sessionId,
              draftId: input.draftId,
            })
          : await prepareGmailMessageTrash({
              ownerId: input.ownerId,
              googleSessionId: input.googleSessionId,
              sessionId: input.sessionId,
              messageId: input.messageId,
            });
      return {
        output: confirmationOutput(
          prepared,
          capability === "mail.send"
            ? "Изпращането на Gmail черновата"
            : "Преместването на Gmail съобщението в кошчето",
        ),
        metadata: {
          confirmationId: prepared.confirmationId,
          confirmationType: "capability",
        },
      };
    }
    const messages = input.query
      ? await searchGmailMessages(
          input.googleSessionId,
          input.query,
          input.limit || 10,
        )
      : await listGmailMessages(input.googleSessionId, input.limit || 10);
    if (!messages.length) return "Няма намерени съобщения в Gmail.";
    return [
      "Последни съобщения в Gmail:",
      ...messages.map(
        (message) =>
          `• ${message.unread ? "Непрочетено — " : ""}${message.subject} — ${message.from}`,
      ),
    ].join("\n");
  },
  "youtube-channel": async ({ input }) => {
    const { channel, videos } = await getYoutubeChannelSummary(input.googleSessionId);
    if (useEnglishReplyFallback(input.language)) {
      if (!channel) return "This Google account has no YouTube channel.";
      const count = (value) => (value === null ? "hidden" : value.toLocaleString("en-US"));
      return [
        `YouTube channel "${channel.title}": ${count(channel.subscribers)} subscribers, ${count(channel.views)} views, ${count(channel.videos)} videos.`,
        ...(videos.length ? ["Latest videos:"] : []),
        ...videos.map(
          (video) =>
            `• ${video.title} (${String(video.publishedAt || "").slice(0, 10)}) — ${count(video.views)} views, ${count(video.likes)} likes, ${count(video.comments)} comments — ${video.url}`,
        ),
      ].join("\n");
    }
    if (!channel) return "Към този Google профил няма YouTube канал.";
    const number = (value) => (value === null ? "скрито" : value.toLocaleString("bg-BG"));
    return [
      `YouTube канал „${channel.title}“: ${number(channel.subscribers)} абонати, ${number(channel.views)} гледания, ${number(channel.videos)} видеа.`,
      ...(videos.length ? ["Последни видеа:"] : []),
      ...videos.map(
        (video) =>
          `• ${video.title} (${String(video.publishedAt || "").slice(0, 10)}) — ${number(video.views)} гледания, ${number(video.likes)} харесвания, ${number(video.comments)} коментара — ${video.url}`,
      ),
    ].join("\n");
  },
  "google-contacts": async ({ capability, input, confirmed }) => {
    if (capability === "contacts.read") {
      const contacts = await searchGoogleContacts(
        input.googleSessionId,
        requiredInput(input.query || input.message, "заявка за контакт"),
        input.limit || 10,
      );
      const english = useEnglishReplyFallback(input.language);
      if (!contacts.length) {
        return english ? "No Google contacts found." : "Няма намерени Google контакти.";
      }
      return [
        english ? "Contacts found:" : "Намерени контакти:",
        ...contacts.map(
          (contact) =>
            `• ${contact.name}${contact.email ? ` — ${contact.email}` : ""}${contact.phone ? ` — ${contact.phone}` : ""}`,
        ),
      ].join("\n");
    }
    if (confirmed) {
      const contact = await confirmGoogleAction({
        ownerId: input.ownerId,
        googleSessionId: input.googleSessionId,
        sessionId: input.sessionId,
        confirmationId: requiredInput(input.confirmationId, "confirmationId"),
      });
      return `Google контактът е записан: ${contact.name}.`;
    }
    const prepared = await prepareGoogleContactChange({
      ownerId: input.ownerId,
      googleSessionId: input.googleSessionId,
      sessionId: input.sessionId,
      operation: capability === "contacts.create" ? "create" : "update",
      contact: input.contact,
    });
    return {
      output: confirmationOutput(prepared, "Промяната на Google контакта"),
      metadata: {
        confirmationId: prepared.confirmationId,
        confirmationType: "capability",
      },
    };
  },
  "synchron-tasks": async ({ capability, input, confirmed }) => {
    if (capability === "tasks.read" || capability === "tasks.progress") {
      const tasks = await listTasks({
        ownerId: input.ownerId,
        unfinished:
          capability === "tasks.progress" ? true : input.unfinished === true,
        status: input.status,
        projectId: input.projectId,
        limit: input.limit,
      });
      if (!tasks.length) return "Няма намерени задачи.";
      return [
        "Задачи:",
        ...tasks.map(
          (task) =>
            `• ${task.title} — ${task.status}${task.projectId ? ` — проект ${task.projectId}` : ""}`,
        ),
      ].join("\n");
    }
    if (capability === "tasks.note") {
      const task = await addTaskNote({
        ownerId: input.ownerId,
        taskId: input.taskId,
        note: input.note || input.message,
      });
      return `Бележката е добавена към „${task.title}“.`;
    }
    if (capability === "tasks.link-project") {
      const task = await linkTaskToProject({
        ownerId: input.ownerId,
        taskId: input.taskId,
        projectId: input.projectId,
      });
      return `Задачата „${task.title}“ е свързана с проект ${task.projectId}.`;
    }
    if (capability === "tasks.status") {
      if (confirmed) {
        const task = await confirmTaskStatusChange({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          confirmationId: requiredInput(input.confirmationId, "confirmationId"),
        });
        return `Статусът на „${task.title}“ е променен на ${task.status}.`;
      }
      const prepared = await prepareTaskStatusChange({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        status: input.status,
      });
      return {
        output: confirmationOutput(prepared, "Промяната на статуса"),
        metadata: {
          confirmationId: prepared.confirmationId,
          confirmationType: "capability",
        },
      };
    }
    const task = await createTaskDraft({
      ownerId: input.ownerId,
      title: input.title || input.message,
      projectId: input.projectId,
      note: input.note,
    });
    return `Създадена е чернова на задача: ${task.title}.`;
  },
  "openai-web-search": async ({ input }) =>
    formatWebSearchResult(await searchWeb(input.message)),
  "gemini-youtube": async ({ input }) =>
    formatGeminiToolResult(await summarizeYoutubeVideo(input.message)),
  "gemini-maps": async ({ input }) =>
    formatGeminiToolResult(await askGoogleMaps(input.message)),
  "google-cloud-read": async () =>
    formatGoogleCloudRuntimeStatus(getGoogleCloudRuntimeStatus()),
  "google-cloud-diagnostics": async () =>
    formatProjectDiagnostics(await getProjectDiagnostics()),
  "google-cloud-write": async ({ input, confirmed }) => {
    const operationInput = input.input || input;
    const result = confirmed
      ? await confirmGoogleCloudAction({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          confirmationId: requiredInput(input.confirmationId, "confirmationId"),
        })
      : await prepareGoogleCloudAction({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          operation: requiredInput(input.operation, "operation"),
          input: operationInput,
        });
    return {
      output: confirmed
        ? "Точната потвърдена Google Cloud промяна е изпълнена."
        : confirmationOutput(result, "Google Cloud промяната"),
      metadata: {
        result,
        confirmationId: result.confirmationId,
        confirmationType: "capability",
      },
    };
  },
  "google-firestore-memory": async ({ capability, input }) => {
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
  if (resolved.requiresConfirmation && options.confirmed !== true) {
    const canPrepareConfirmation =
      options.prepareConfirmation === true &&
      [
        "github-write",
        "github-confirmed-write",
        "google-calendar-write",
        "gmail-read",
        "google-contacts",
        "synchron-tasks",
        "google-cloud-write",
      ].includes(resolved.tool.id);
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

  const execution = await executor({
    capability: resolved.capability,
    input,
    confirmed: options.confirmed === true,
  });
  const output = typeof execution === "string" ? execution : execution?.output;
  if (typeof output !== "string" || !output.trim()) {
    throw new CapabilityError(
      `Инструментът "${resolved.tool.name}" не върна валиден резултат.`,
      "CAPABILITY_EMPTY_RESULT",
      502,
    );
  }

  const metadata =
    execution?.metadata &&
    typeof execution.metadata === "object" &&
    !Array.isArray(execution.metadata)
      ? Object.freeze({ ...execution.metadata })
      : null;
  return Object.freeze({
    ...resolved,
    output,
    ...(metadata ? { metadata } : {}),
  });
}

export function isToolExecutable(toolId, env = process.env) {
  return typeof executors[toolId] === "function";
}

export function extractGitHubTaskNumber(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (
    !/(?:статус|състояние|какво\s+става|докъде|прослед|провери|готов|ci|checks?|проверки|deployment|деплой)/iu.test(
      text,
    ) ||
    !/(?:github|ги[тд][\s-]*хъб|задач|issue|pull\s*request|\bpr\b)/iu.test(text)
  ) {
    return null;
  }
  const match = text.match(
    /#\s*(\d{1,10})|(?:задач|issue|\bpr\b)[^\d]{0,20}(\d{1,10})/iu,
  );
  const value = Number(match?.[1] || match?.[2]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isGitHubTaskStatusRequest(message) {
  return extractGitHubTaskNumber(message) !== null;
}

export function isGitHubWriteStatusRequest(message) {
  const text = typeof message === "string" ? message.trim() : "";
  return (
    /(?:github|ги[тд][\s-]*хъб|(?:^|\s)хъб(?:ът|а)?(?=\s|[?!.,:;]|$)|github\s*write)/iu.test(
      text,
    ) &&
    /(?:пиш(?:е|а|еш)|писан|запис|\bwrite\b|branch|клон|commit|комит|pull\s*request|\bpr\b|merge|слив)/iu.test(
      text,
    ) &&
    /(?:може\s+ли|може\s+вече|може\s+да|работи\s+ли|има\s+ли|активен|наличен|свързан|готов|инструмент|мост)/iu.test(
      text,
    ) &&
    !/(?:^|\s)(?:направи|промени|обнови|редактирай|поправи|създай|слей)(?:\s|$)/iu.test(
      text,
    )
  );
}
