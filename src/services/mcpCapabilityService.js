import {
  confirmCalendarEvent,
  formatCalendarEventResult,
  prepareCalendarEvent,
} from "./calendarService.js";
import {
  confirmGitHubChange,
  prepareGitHubChange,
} from "./githubActionService.js";
import {
  getConfiguredRepository,
  getFileContent,
  getGitHubReadOverview,
  GitHubServiceError,
} from "./githubService.js";
import {
  confirmGoogleCloudAction,
  prepareGoogleCloudAction,
} from "./googleCloudActionService.js";
import {
  getLatestAuthorizedGitHubSession,
  isActiveAuthorizedGitHubSession,
} from "./githubOAuthService.js";
import {
  confirmGoogleAction,
  prepareGmailDraftSend,
  prepareGmailMessageTrash,
  prepareGoogleContactChange,
} from "./googleActionService.js";
import {
  createGmailDraft,
  getLatestGoogleSessionId,
  GoogleDriveError,
  listDriveFiles,
  listGoogleCalendarEvents,
  saveSessionFor,
  fileSaveSessionFor,
  saveVideoToDrive,
  downloadOwnDriveVideo,
  publishSessionFor,
  uploadVideoToYoutube,
  searchGmailMessages,
  searchGoogleContacts,
  suggestGoogleCalendarSlots,
} from "./googleDriveService.js";
import {
  confirmMemoryDelete,
  prepareMemoryDelete,
} from "./memoryDeleteConfirmationService.js";
import {
  confirmMemoryWrite,
  prepareMemoryWrite,
} from "./memoryWriteConfirmationService.js";
import {
  listConversationMessages,
  listConversationSummaries,
  MAX_IMPORTED_CONVERSATION_MESSAGES,
  MAX_IMPORTED_MESSAGE_LENGTH,
  normalizeProfileMemoryDraft,
  saveImportedConversation,
} from "./memoryService.js";
import { sendMcpAgentMessage } from "./mcpAgentConversationService.js";
import { suggestMemory } from "./memorySuggestionService.js";
import { readRuntimeLogs } from "./runtimeLogService.js";
import { getProjectDiagnostics } from "./projectDiagnosticsService.js";
import { mcpToolSecuritySchemes } from "./mcpOAuthService.js";
import {
  listAuditEvents,
  listPermissions,
  recordAuditEvent,
} from "./permissionService.js";
import {
  addTaskNote,
  confirmTaskStatusChange,
  createTaskDraft,
  linkTaskToProject,
  listTasks,
  prepareTaskStatusChange,
  TASK_MANAGEMENT_STATUSES,
} from "./taskManagementService.js";
import { loadWorkspaceState } from "./workspaceStateService.js";
import {
  AVATAR_PROFILE_FIELDS,
  getAvatarProfileService,
} from "./avatarProfileService.js";
import { formatSelfTest, runSelfTest } from "./selfTestService.js";
import { getVideoGenerationService } from "./videoGenerationService.js";
import {
  getToolRuntimeAvailability,
  isToolExecutable,
} from "../tools/capabilityEngine.js";
import { listTools, registerCoreTools } from "../tools/toolRegistry.js";

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
const REVERSIBLE_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: false,
});
const CONFIRMED_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: false,
});
const MEMORY_SCOPE_SCHEMA = Object.freeze({
  type: "string",
  enum: ["personal", "project"],
  default: "personal",
});

function tool(name, title, description, inputSchema, annotations = READ_ONLY) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: Object.freeze(inputSchema),
    securitySchemes: mcpToolSecuritySchemes(name),
    annotations,
  });
}

export const MCP_CAPABILITY_TOOLS = Object.freeze([
  tool(
    "send_message",
    "Изпрати съобщение до Novarium",
    "Изпраща съобщение до агента в сайта, връща неговия отговор и започва нова нишка. Използва само регистрирани инструменти; read-only проверките се изпълняват, а записите се подготвят за отделно owner потвърждение.",
    {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 6000 },
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        agentId: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["message"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "read_reply",
    "Прочети последния отговор",
    "Прочита последния отговор на Novarium от точна нишка на текущия профил.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  ),
  tool(
    "list_threads",
    "Покажи нишките на Novarium",
    "Показва разговорите в сайта само за текущия профил.",
    {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "read_history",
    "Прочети историята на нишка",
    "Прочита съобщенията от точна Novarium нишка само за текущия профил.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  ),
  tool(
    "continue_session",
    "Продължи Novarium нишка",
    "Задава следващ въпрос в точна нишка. В една MCP сесия са разрешени до 10 потребителски въпроса.",
    {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
        message: { type: "string", minLength: 1, maxLength: 6000 },
        projectId: { type: "string", minLength: 1, maxLength: 80 },
        agentId: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["sessionId", "message"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "suggest_memory",
    "Предложи факт за паметта",
    "Изпраща факт към „Входящи“ в Novarium. Потребителят го одобрява, редактира или отхвърля в сайта; нищо не влиза в постоянната памет без неговото одобрение. Използвай за трайни факти, решения и предпочитания, които ще са полезни в бъдещи разговори.",
    {
      type: "object",
      properties: {
        fact: { type: "string", minLength: 1, maxLength: 500 },
        scope: MEMORY_SCOPE_SCHEMA,
        source: {
          type: "string",
          enum: ["claude", "chatgpt", "gemini", "other"],
          default: "claude",
        },
      },
      required: ["fact"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "save_conversation",
    "Запази разговора в Novarium",
    "Запазва текущия разговор от Claude (или друг AI клиент) като нишка в Novarium за текущия профил, за да може да се продължи по-късно оттук или от сайта. Изпращай само съобщенията, които потребителят иска да запази. Без sessionId създава нова нишка; с sessionId от предишен запис добавя новите съобщения към нея. Не записва факти в постоянната памет.",
    {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["claude", "chatgpt", "other"],
          default: "claude",
        },
        sessionId: { type: "string", minLength: 1, maxLength: 160 },
        messages: {
          type: "array",
          minItems: 1,
          maxItems: MAX_IMPORTED_CONVERSATION_MESSAGES,
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: {
                type: "string",
                minLength: 1,
                maxLength: MAX_IMPORTED_MESSAGE_LENGTH,
              },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["messages"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "propose_memory_change",
    "Предложи промяна в паметта",
    "Нормализира точен факт и показва какво би се записало, обновило или изтрило. Не променя паметта.",
    {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["save", "update", "delete"] },
        fact: { type: "string", minLength: 1, maxLength: 2000 },
        scope: MEMORY_SCOPE_SCHEMA,
        memoryId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["operation", "fact"],
      additionalProperties: false,
    },
  ),
  tool(
    "prepare_memory_write",
    "Подготви запис в паметта",
    "Подготвя точен постоянен запис или обновяване и връща еднократно потвърждение. Не записва нищо.",
    {
      type: "object",
      properties: {
        fact: { type: "string", minLength: 1, maxLength: 2000 },
        scope: MEMORY_SCOPE_SCHEMA,
        memoryId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["fact"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_memory_write",
    "Потвърди запис в паметта",
    "Записва само точния предварително подготвен факт след валидно еднократно потвърждение.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "prepare_memory_delete",
    "Подготви изтриване от паметта",
    "Подготвя изтриване на точен факт, точен id или избран обхват. Не изтрива нищо.",
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact", "id", "all"] },
        fact: { type: "string", minLength: 1, maxLength: 2000 },
        id: { type: "string", minLength: 1, maxLength: 200 },
        scope: MEMORY_SCOPE_SCHEMA,
      },
      required: ["kind"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_memory_delete",
    "Потвърди изтриване от паметта",
    "Изтрива само точната предварително подготвена цел след еднократно потвърждение.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "list_available_capabilities",
    "Покажи реалните инструменти и права",
    "Показва Tool Registry, capabilities, решенията allow/confirm/deny и текущата runtime наличност без тайни.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "list_action_history",
    "Покажи историята на действията",
    "Прочита безопасно изчистения журнал без API ключове, пароли, token-и и сурови потвърждения.",
    {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  ),
  tool(
    "get_avatar_profile",
    "Прочети профила на аватара",
    "Показва „Профил на аватара“ на свързания профил: кой съм, как говоря, цели, навици и какво аватарът да не прави. Само четене.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "update_avatar_profile",
    "Попълни профила на аватара",
    "Записва само подадените полета в „Профил на аватара“ на свързания профил; другите остават както са. Връща и предишния текст, за да може промяната да се върне. Празен текст изтрива полето.",
    {
      type: "object",
      properties: Object.fromEntries(
        AVATAR_PROFILE_FIELDS.map(({ id, max }) => [
          id,
          { type: "string", maxLength: max },
        ]),
      ),
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "read_runtime_logs",
    "Прочети логовете на сървъра",
    "Само за собственика. Показва последните записи от Cloud Run логовете на Novarium (по подразбиране предупреждения и грешки за последния час). Ключове, токени и имейли са скрити. Само четене.",
    {
      type: "object",
      properties: {
        minutes: { type: "integer", minimum: 1, maximum: 1440, default: 60 },
        severity: {
          type: "string",
          enum: ["DEFAULT", "INFO", "WARNING", "ERROR"],
          default: "WARNING",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        contains: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "list_recent_errors",
    "Покажи последните безопасни грешки",
    "Показва само безопасните кодове и състояния от последните неуспешни действия. Не връща stack, response body или secrets.",
    {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  ),
  tool(
    "list_tasks",
    "Покажи задачите",
    "Показва задачите на текущия профил, включително само незавършените и тези за конкретен проект.",
    {
      type: "object",
      properties: {
        unfinished: { type: "boolean", default: false },
        status: { type: "string", enum: TASK_MANAGEMENT_STATUSES },
        projectId: { type: "string", minLength: 1, maxLength: 160 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "create_task_draft",
    "Създай чернова на задача",
    "Създава обратима чернова в личния task store. Не стартира външно действие.",
    {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 240 },
        projectId: { type: "string", minLength: 1, maxLength: 160 },
        note: { type: "string", maxLength: 2000 },
      },
      required: ["title"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "add_task_note",
    "Добави бележка към задача",
    "Добавя обратима бележка към точна задача на текущия профил.",
    {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 160 },
        note: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["taskId", "note"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "link_task_to_project",
    "Свържи задача с проект",
    "Свързва точна задача с проект от същия профил. Не стартира външно действие.",
    {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 160 },
        projectId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["taskId", "projectId"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "prepare_task_status_change",
    "Подготви промяна на статус",
    "Подготвя точна промяна на задача и връща еднократно потвърждение. Не променя статуса.",
    {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 160 },
        status: { type: "string", enum: TASK_MANAGEMENT_STATUSES },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_task_status_change",
    "Потвърди промяна на статус",
    "Променя само предварително подготвения статус след еднократно потвърждение.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "list_projects",
    "Покажи проектите",
    "Показва проектите от личната работна област и техния проверен напредък.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "get_github_overview",
    "Провери GitHub repository, issues, PR-и и Actions",
    "Чете само разрешеното repository и връща последни commits, отворени issues, Pull Request-и и workflow runs.",
    {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
  ),
  tool(
    "get_github_file",
    "Прочети GitHub файл",
    "Прочита текстов файл само от разрешеното repository и избран ref.",
    {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500 },
        ref: { type: "string", minLength: 1, maxLength: 200, default: "main" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  ),
  tool(
    "prepare_github_change",
    "Подготви ограничена GitHub промяна",
    "Подготвя branch, file commit, Pull Request, проверено сливане към main или затваряне на issue. Не изпълнява промяната без отделно owner потвърждение.",
    {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "create_branch",
            "create_file",
            "update_file",
            "create_pr",
            "merge_pr",
            "close_issue",
          ],
        },
        input: { type: "object", additionalProperties: true },
      },
      required: ["operation", "input"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_github_change",
    "Потвърди ограничена GitHub промяна",
    "Изпълнява само точната подготвена GitHub промяна след еднократно owner потвърждение. Сливането е ограничено до конкретен PR към main, точен head SHA и зелени CI проверки; production deployment не се изпълнява.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "prepare_google_cloud_action",
    "Подготви Google Cloud промяна",
    "Подготвя точна IAM промяна, смяна на service identity на текущата Cloud Run услуга, превключване на AI ключ (ANTHROPIC/OPENAI/GEMINI/GROK_API_KEY) към последната версия на тайната му включване на Google като доставчик за вход в Identity Platform (enable_google_sign_in, без input; ползва OAuth клиента на услугата), включване на GitHub като доставчик за вход (enable_github_sign_in, без input; ползва GitHub OAuth приложението на услугата), включване на едно от разрешените Google API (enable_google_api, input {api}: youtube, youtubeanalytics, photospicker, meet, docs, sheets или people .googleapis.com) или стартиране на съществуващия synchron-main-deploy Cloud Build trigger за точен commit SHA. Не чете стойности на тайни и не променя нищо без отделно потвърждение.",
    {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "grant_project_role",
            "revoke_project_role",
            "update_cloud_run_service_account",
            "run_cloud_build_trigger",
            "use_latest_secret_version",
            "enable_google_sign_in",
            "enable_github_sign_in",
            "enable_google_api",
          ],
        },
        input: { type: "object", additionalProperties: true },
      },
      required: ["operation", "input"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_google_cloud_action",
    "Потвърди Google Cloud промяна",
    "Изпълнява само точната предварително подготвена Google Cloud IAM, Cloud Run или Cloud Build trigger промяна след еднократно потвърждение и записва audit събитие.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "get_google_cloud_project_diagnostics",
    "Провери състоянието на Novarium проекта",
    "Проверява само за четене сайта, MCP, Cloud Run, Cloud Build, Firestore, Monitoring, Logging, Cloud Resource Manager и метаданни за версии на тайни за текущия проект.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "run_novarium_self_test",
    "Пусни самопроверка на Novarium",
    "Само за собственика. Прави реални проверки отвътре: чат с всеки конфигуриран модел, гласово разпознаване с тестов запис, четене на PDF, създаване/отваряне/спиране на линк за споделяне и списъците с модели и асистенти. Струва няколко цента AI заявки, пипа само собствени тестови данни и ги изтрива.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "list_google_drive_files",
    "Покажи Google Drive файловете",
    "Показва файлове само от свързаната собственическа Google сесия.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool(
    "search_gmail",
    "Търси в Gmail",
    "Търси и чете безопасни Gmail резюмета от свързания собственически профил.",
    {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  ),
  tool(
    "generate_video",
    "Направи видео и го запази в Google Drive",
    "Само за собственика. Прави кратко видео (реклама и др.) от описание с Gemini Omni Flash: до 10 секунди, 720p, със звук; 9:16 за телефон или 16:9. Добавя глас зад кадър (narration — текстът; без него Novarium пише кратък текст на езика на описанието) и фонова музика; sound=false ги спира. Записва MP4 файла като нов файл в Google Drive на собственика и връща линк. Отнема 1–4 минути и струва около 1 $. Нищо не се публикува.",
    {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 3, maxLength: 2000 },
        aspectRatio: { type: "string", enum: ["16:9", "9:16"] },
        title: { type: "string", maxLength: 100 },
        narration: { type: "string", maxLength: 400 },
        sound: { type: "boolean" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "publish_video_to_youtube",
    "Качи видео от Google Drive в YouTube",
    "Само за собственика. Качва MP4 видео, което Novarium е записал в Google Drive (fileId от generate_video), в YouTube канала на собственика. По подразбиране е private; unlisted или public само по негово изрично желание. Докато приложението не мине одита на YouTube API, YouTube държи каченото като private.",
    {
      type: "object",
      properties: {
        driveFileId: { type: "string", minLength: 5, maxLength: 200 },
        title: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 5000 },
        privacy: { type: "string", enum: ["private", "unlisted", "public"], default: "private" },
      },
      required: ["driveFileId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "create_gmail_draft",
    "Създай Gmail чернова",
    "Създава чернова за преглед, но не я изпраща.",
    {
      type: "object",
      properties: {
        to: { type: "string", minLength: 3, maxLength: 320 },
        subject: { type: "string", maxLength: 500 },
        body: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "prepare_gmail_send",
    "Подготви изпращане на Gmail чернова",
    "Прочита точната чернова и връща еднократно потвърждение. Не изпраща нищо.",
    {
      type: "object",
      properties: { draftId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["draftId"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "prepare_gmail_delete",
    "Подготви преместване на имейл в кошчето",
    "Проверява точния Gmail message и връща еднократно потвърждение. Не изтрива нищо.",
    {
      type: "object",
      properties: {
        messageId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_google_action",
    "Потвърди Google действие",
    "Изпраща точната Gmail чернова, мести точния message в кошчето или променя точния контакт след еднократно потвърждение.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "list_google_calendar_events",
    "Покажи Google Calendar",
    "Показва предстоящите събития от свързания собственически календар.",
    {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "suggest_calendar_slots",
    "Предложи свободни часове",
    "Предлага свободни работни интервали според текущия Google Calendar. Не създава и не променя събития.",
    {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30 },
        durationMinutes: { type: "integer", minimum: 15, maximum: 240 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "prepare_calendar_event",
    "Подготви календарно събитие",
    "Подготвя точен event или reminder и връща еднократно потвърждение. Не записва събитие.",
    {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 3000 },
      },
      required: ["message"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
  tool(
    "confirm_calendar_event",
    "Потвърди календарно събитие",
    "Създава само предварително подготвеното събитие след еднократно потвърждение без покани към участници.",
    {
      type: "object",
      properties: {
        confirmationId: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["confirmationId"],
      additionalProperties: false,
    },
    CONFIRMED_WRITE,
  ),
  tool(
    "search_google_contacts",
    "Търси Google контакт",
    "Търси име, имейл и телефон само в свързания собственически Google профил.",
    {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  ),
  tool(
    "prepare_google_contact",
    "Подготви Google контакт",
    "Подготвя добавяне или промяна на точен контакт. Не записва нищо без отделно потвърждение. При промяна (resourceName и etag от търсенето) се сменя само подаденото: името, основният имейл или основният телефон; другите имейли и телефони остават.",
    {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "update"] },
        contact: { type: "object", additionalProperties: true },
      },
      required: ["operation", "contact"],
      additionalProperties: false,
    },
    REVERSIBLE_WRITE,
  ),
]);

const TOOL_NAMES = new Set(MCP_CAPABILITY_TOOLS.map(({ name }) => name));

const MAX_STRUCTURED_TEXT_LENGTH = 50_000;

// Clients that only read `content` (Claude among them) otherwise see just the
// one-line summary. Per the MCP spec, structured results are also returned as
// serialized JSON in a text block. The data is the same already-sanitized
// structuredContent, so nothing new is exposed.
function textResult(data, summary) {
  const content = [{ type: "text", text: summary }];
  if (data !== undefined) {
    let json = JSON.stringify(data);
    if (typeof json === "string" && json !== "{}") {
      if (json.length > MAX_STRUCTURED_TEXT_LENGTH) {
        json = `${json.slice(0, MAX_STRUCTURED_TEXT_LENGTH)}…`;
      }
      content.push({ type: "text", text: json });
    }
  }
  return { structuredContent: data, content };
}

function cleanAuditEvent(event) {
  return {
    timestamp: event.timestamp || null,
    action: event.action || "unknown",
    capability: event.capability || null,
    decision: event.decision || null,
    phase: event.phase || null,
    outcome: event.outcome || null,
    resource: event.resource || null,
    details: event.details || null,
  };
}

async function requireGoogleSession(resolveLatestGoogleSession) {
  const id = await resolveLatestGoogleSession();
  if (!id) {
    throw new GoogleDriveError(
      "Google не е свързан. Отвори https://cloudaicore.com/api/google/connect.",
      401,
      "NOT_CONNECTED",
    );
  }
  return id;
}

async function resolveGitHubReadOptions(resolveLatestGitHubSession) {
  const session = await resolveLatestGitHubSession();
  if (!session) return {};
  if (!isActiveAuthorizedGitHubSession(session)) {
    throw new GitHubServiceError(
      "GitHub OAuth сесията е невалидна или изтекла.",
      401,
      "GITHUB_SESSION_INVALID",
    );
  }
  return { accessToken: session.accessToken };
}

function memoryDeleteTarget(args = {}) {
  if (args.kind === "fact") {
    return { kind: "fact", fact: args.fact, scope: args.scope || "personal" };
  }
  if (args.kind === "id") return { kind: "id", id: args.id };
  return { kind: "all", scope: args.scope || undefined };
}

function permissionAction(name) {
  if (name === "confirm_google_action") return "external.confirmed";
  if (
    [
      "send_message",
      "read_reply",
      "list_threads",
      "read_history",
      "continue_session",
      "save_conversation",
      "suggest_memory",
    ].includes(name)
  ) {
    return "agent.chat";
  }
  if (name.includes("memory")) {
    return name.includes("confirm") || name.includes("prepare")
      ? name.includes("delete")
        ? "memory.delete"
        : "memory.write"
      : "memory.read";
  }
  if (name.includes("task")) {
    return name.includes("status")
      ? "tasks.update"
      : name === "list_tasks"
        ? "tasks.read"
        : "tasks.draft";
  }
  if (name.includes("github")) {
    return name.includes("change") ? "github.write" : "github.read";
  }
  if (name === "get_google_cloud_project_diagnostics") {
    return "infrastructure.read";
  }
  if (name.includes("google_cloud")) return "infrastructure.write";
  if (name.includes("gmail")) {
    if (name === "search_gmail") return "mail.read";
    if (name === "create_gmail_draft") return "mail.draft";
    return name.includes("delete") ? "mail.delete" : "mail.send";
  }
  if (name.includes("contact")) {
    return name.startsWith("search") ? "contacts.read" : "contacts.write";
  }
  if (name.includes("calendar")) {
    return name.startsWith("list") || name.startsWith("suggest")
      ? "calendar.read"
      : "calendar.write";
  }
  if (name === "list_google_drive_files") return "drive.read";
  if (name === "generate_video") return "drive.write";
  if (name === "publish_video_to_youtube") return "youtube.write";
  return "infrastructure.read";
}

export function createMcpCapabilityHandler({
  audit = recordAuditEvent,
  readAudit = listAuditEvents,
  resolveLatestGoogleSession = getLatestGoogleSessionId,
  resolveLatestGitHubSession = getLatestAuthorizedGitHubSession,
  dependencies = {},
} = {}) {
  return async function callMcpCapabilityTool(name, args = {}, context = {}) {
    if (!TOOL_NAMES.has(name)) return { handled: false, result: null };
    const ownerId = context.ownerId;
    if (typeof ownerId !== "string" || !ownerId.trim()) {
      throw Object.assign(new Error("Липсва проверен MCP профил."), {
        code: -32602,
      });
    }
    const sessionId = ownerId;
    let result;

    if (name === "send_message" || name === "continue_session") {
      const conversation = await (
        dependencies.sendAgentMessage || sendMcpAgentMessage
      )({
        ownerId,
        message: args.message,
        sessionId: name === "continue_session" ? args.sessionId : undefined,
        projectId: args.projectId,
        agentId: args.agentId,
        identity: context.identity,
      });
      result = textResult(conversation, conversation.response);
    } else if (name === "list_threads") {
      const items = await (
        dependencies.listConversations || listConversationSummaries
      )(args.limit || 20, ownerId);
      result = textResult(
        { items },
        `Намерени са ${items.length} Novarium нишки.`,
      );
    } else if (name === "read_history" || name === "read_reply") {
      const items = await (
        dependencies.listMessages || listConversationMessages
      )(args.sessionId, undefined, ownerId);
      if (name === "read_reply") {
        const reply =
          items.findLast((item) => item.role === "assistant") || null;
        result = textResult(
          { sessionId: args.sessionId, reply },
          reply?.content || "В тази нишка още няма отговор от Novarium.",
        );
      } else {
        result = textResult(
          { sessionId: args.sessionId, items },
          `Прочетени са ${items.length} съобщения от Novarium нишката.`,
        );
      }
    } else if (name === "suggest_memory") {
      const suggestion = await (
        dependencies.suggestMemory || suggestMemory
      )({
        ownerId,
        fact: args.fact,
        scope: args.scope || "personal",
        source: args.source || "claude",
      });
      result = textResult(
        suggestion,
        suggestion.duplicate
          ? "Това предложение вече чака във „Входящи“ в Novarium."
          : "Предложението е във „Входящи“ в Novarium и чака одобрение. Паметта не е променена.",
      );
    } else if (name === "save_conversation") {
      const saved = await (
        dependencies.saveImportedConversation || saveImportedConversation
      )(
        {
          source: args.source || "claude",
          sessionId: args.sessionId,
          messages: args.messages,
        },
        ownerId,
      );
      result = textResult(
        saved,
        saved.appended
          ? `Добавени са ${saved.saved} съобщения към нишка ${saved.sessionId}.`
          : `Разговорът е запазен в Novarium като нишка ${saved.sessionId} (${saved.saved} съобщения).`,
      );
    } else if (name === "propose_memory_change") {
      const item = normalizeProfileMemoryDraft(
        args.fact,
        args.scope || "personal",
      );
      const proposal = {
        operation: args.operation,
        ...item,
        ...(args.memoryId ? { memoryId: args.memoryId } : {}),
        persisted: false,
      };
      result = textResult(
        proposal,
        `Предложение без запис: ${args.operation} — ${item.fact}`,
      );
    } else if (name === "prepare_memory_write") {
      const prepared = await (
        dependencies.prepareMemoryWrite || prepareMemoryWrite
      )({
        sessionId,
        ownerId,
        items: [{ fact: args.fact, scope: args.scope || "personal" }],
        replaceId: args.memoryId,
      });
      result = textResult(
        prepared,
        "Записът е подготвен, но паметта не е променена.",
      );
    } else if (name === "confirm_memory_write") {
      const items = await (
        dependencies.confirmMemoryWrite || confirmMemoryWrite
      )({
        confirmationId: args.confirmationId,
        sessionId,
        ownerId,
        source: "chatgpt-mcp-confirmed-memory",
      });
      result = textResult(
        { items },
        `Потвърдено са записани ${items.length} факта.`,
      );
    } else if (name === "prepare_memory_delete") {
      const prepared = await (
        dependencies.prepareMemoryDelete || prepareMemoryDelete
      )({
        sessionId,
        ownerId,
        target: memoryDeleteTarget(args),
      });
      result = textResult(
        prepared,
        "Изтриването е подготвено, но паметта не е променена.",
      );
    } else if (name === "confirm_memory_delete") {
      const deleted = await (
        dependencies.confirmMemoryDelete || confirmMemoryDelete
      )({
        confirmationId: args.confirmationId,
        sessionId,
        ownerId,
      });
      result = textResult(
        deleted,
        "Потвърдената цел е изтрита от постоянната памет.",
      );
    } else if (name === "list_available_capabilities") {
      registerCoreTools();
      const [googleSessionId, githubSession] = await Promise.all([
        resolveLatestGoogleSession(),
        resolveLatestGitHubSession(),
      ]);
      const tools = listTools().map((registered) => ({
        id: registered.id,
        provider: registered.provider,
        name: registered.name,
        capabilities: registered.capabilities,
        permissions: registered.permissions,
        executable: isToolExecutable(registered.id),
        runtime: getToolRuntimeAvailability(registered.id, {
          ownerId,
          googleSessionId,
          githubSessionId: githubSession ? "connected" : "",
        }),
      }));
      result = textResult(
        { tools, permissions: listPermissions() },
        `Проверени са ${tools.length} инструмента и ${listPermissions().length} разрешения.`,
      );
    } else if (name === "get_avatar_profile") {
      const service = dependencies.avatarProfileService || getAvatarProfileService();
      const profile = await service.read(ownerId);
      const empty = AVATAR_PROFILE_FIELDS.filter(({ id }) => !profile[id]).map(({ label }) => label);
      result = textResult(
        { profile, fields: AVATAR_PROFILE_FIELDS, empty },
        empty.length ? `Празни полета: ${empty.join(", ")}.` : "Всички полета са попълнени.",
      );
    } else if (name === "update_avatar_profile") {
      const service = dependencies.avatarProfileService || getAvatarProfileService();
      const previous = await service.read(ownerId);
      const changes = Object.fromEntries(
        AVATAR_PROFILE_FIELDS.filter(({ id }) => typeof args[id] === "string").map(({ id }) => [id, args[id]]),
      );
      if (!Object.keys(changes).length) {
        throw Object.assign(new Error("Няма подадено поле за запис."), { code: -32602 });
      }
      const profile = await service.save(ownerId, { ...previous, ...changes });
      result = textResult(
        { profile, previous },
        `Записани полета: ${AVATAR_PROFILE_FIELDS.filter(({ id }) => id in changes).map(({ label }) => label).join(", ")}.`,
      );
    } else if (name === "read_runtime_logs") {
      if (context.identity?.role && context.identity.role !== "owner") {
        throw Object.assign(new Error("Само за собственика."), { code: -32602 });
      }
      const logs = await (dependencies.readRuntimeLogs || readRuntimeLogs)({
        minutes: args.minutes,
        severity: args.severity,
        limit: args.limit,
        contains: args.contains,
      });
      result = textResult(
        logs,
        `Прочетени са ${logs.count} записа от логовете за последните ${logs.minutes} минути.`,
      );
    } else if (
      name === "list_action_history" ||
      name === "list_recent_errors"
    ) {
      const items = (
        await readAudit(name === "list_recent_errors" ? 100 : args.limit || 50)
      )
        .map(cleanAuditEvent)
        .filter((item) =>
          name === "list_recent_errors"
            ? ["failed", "blocked", "uncertain"].includes(item.outcome)
            : true,
        )
        .slice(0, args.limit || (name === "list_recent_errors" ? 20 : 50));
      result = textResult(
        { items },
        name === "list_recent_errors"
          ? `Намерени са ${items.length} безопасно изчистени грешки.`
          : `Намерени са ${items.length} журнални събития.`,
      );
    } else if (name === "list_tasks") {
      const items = await (dependencies.listTasks || listTasks)({
        ownerId,
        unfinished: args.unfinished === true,
        status: args.status,
        projectId: args.projectId,
        limit: args.limit,
      });
      result = textResult({ items }, `Намерени са ${items.length} задачи.`);
    } else if (name === "create_task_draft") {
      const task = await (dependencies.createTaskDraft || createTaskDraft)({
        ownerId,
        title: args.title,
        projectId: args.projectId,
        note: args.note,
      });
      result = textResult(task, `Създадена е чернова: ${task.title}`);
    } else if (name === "add_task_note") {
      const task = await (dependencies.addTaskNote || addTaskNote)({
        ownerId,
        taskId: args.taskId,
        note: args.note,
      });
      result = textResult(task, "Бележката е добавена към задачата.");
    } else if (name === "link_task_to_project") {
      const task = await (dependencies.linkTaskToProject || linkTaskToProject)({
        ownerId,
        taskId: args.taskId,
        projectId: args.projectId,
      });
      result = textResult(
        task,
        `Задачата е свързана с проект ${task.projectId}.`,
      );
    } else if (name === "prepare_task_status_change") {
      const prepared = await (
        dependencies.prepareTaskStatusChange || prepareTaskStatusChange
      )({
        ownerId,
        sessionId,
        taskId: args.taskId,
        status: args.status,
      });
      result = textResult(
        prepared,
        "Промяната на статус е подготвена, но не е изпълнена.",
      );
    } else if (name === "confirm_task_status_change") {
      const task = await (
        dependencies.confirmTaskStatusChange || confirmTaskStatusChange
      )({
        ownerId,
        sessionId,
        confirmationId: args.confirmationId,
      });
      result = textResult(task, `Статусът е променен на ${task.status}.`);
    } else if (name === "list_projects") {
      const workspace = await (
        dependencies.loadWorkspace || loadWorkspaceState
      )(ownerId);
      result = textResult(
        { items: workspace.state.projects },
        `Намерени са ${workspace.state.projects.length} проекта.`,
      );
    } else if (name === "get_github_overview") {
      const readOptions = await resolveGitHubReadOptions(
        resolveLatestGitHubSession,
      );
      const overview = await (
        dependencies.getGitHubOverview || getGitHubReadOverview
      )({
        limit: args.limit || 10,
        ...readOptions,
      });
      result = textResult(
        overview,
        "GitHub repository, issues, PR-и и Actions са проверени.",
      );
    } else if (name === "get_github_file") {
      if (/^\.env(?:\.|$)/u.test(args.path || "")) {
        throw Object.assign(
          new Error("Чувствителните environment файлове са блокирани."),
          { code: -32602 },
        );
      }
      const readOptions = await resolveGitHubReadOptions(
        resolveLatestGitHubSession,
      );
      const file = await (dependencies.getGitHubFile || getFileContent)(
        args.path,
        getConfiguredRepository(),
        args.ref || "main",
        readOptions,
      );
      result = textResult(file, `Прочетен е ${file.path} от GitHub.`);
    } else if (name === "prepare_github_change") {
      const githubSession = await resolveLatestGitHubSession();
      const prepared = await (
        dependencies.prepareGitHubChange || prepareGitHubChange
      )({
        ownerId,
        sessionId,
        githubSession,
        operation: args.operation,
        input: args.input,
      });
      result = textResult(
        prepared,
        "GitHub промяната е подготвена, но не е изпълнена.",
      );
    } else if (name === "confirm_github_change") {
      const githubSession = await resolveLatestGitHubSession();
      const changed = await (
        dependencies.confirmGitHubChange || confirmGitHubChange
      )({
        ownerId,
        sessionId,
        confirmationId: args.confirmationId,
        githubSession,
      });
      result = textResult(
        changed,
        "Точната потвърдена GitHub промяна е изпълнена.",
      );
    } else if (name === "prepare_google_cloud_action") {
      const prepared = await (
        dependencies.prepareGoogleCloudAction || prepareGoogleCloudAction
      )({
        ownerId,
        sessionId,
        operation: args.operation,
        input: args.input,
      });
      result = textResult(
        prepared,
        "Google Cloud промяната е подготвена, но не е изпълнена.",
      );
    } else if (name === "confirm_google_cloud_action") {
      const changed = await (
        dependencies.confirmGoogleCloudAction || confirmGoogleCloudAction
      )({
        ownerId,
        sessionId,
        confirmationId: args.confirmationId,
      });
      result = textResult(
        changed,
        "Точната потвърдена Google Cloud промяна е изпълнена.",
      );
    } else if (name === "run_novarium_self_test") {
      const report = await (dependencies.runSelfTest || runSelfTest)();
      result = textResult(report, formatSelfTest(report));
    } else if (name === "get_google_cloud_project_diagnostics") {
      const diagnostics = await (
        dependencies.getGoogleCloudProjectDiagnostics || getProjectDiagnostics
      )();
      result = textResult(
        diagnostics,
        `Project diagnostics: ${diagnostics.status || "unknown"}. Read-only проверката е завършена.`,
      );
    } else {
      const googleSessionId = await requireGoogleSession(
        resolveLatestGoogleSession,
      );
      if (name === "list_google_drive_files") {
        const files = await (dependencies.listDriveFiles || listDriveFiles)(
          googleSessionId,
        );
        result = textResult(
          { files },
          `Намерени са ${files.length} Google Drive файла.`,
        );
      } else if (name === "search_gmail") {
        const messages = await (
          dependencies.searchGmail || searchGmailMessages
        )(googleSessionId, args.query, args.limit || 10);
        result = textResult(
          { messages },
          `Намерени са ${messages.length} Gmail съобщения.`,
        );
      } else if (name === "generate_video") {
        // Check the Drive permission first: a video costs about 1 $ and must
        // not be made when it cannot be saved.
        const saveId = await (dependencies.fileSaveSessionFor || fileSaveSessionFor)(googleSessionId);
        if (!saveId) {
          throw new GoogleDriveError(
            "Записът в Google Drive още не е разрешен. Отвори https://cloudaicore.com/api/google/connect?add=save и разреши. Видео не е правено.",
            403,
            "GOOGLE_SCOPE_REQUIRED",
          );
        }
        const made = await (dependencies.generateVideo || ((prompt, options) => getVideoGenerationService().generate(prompt, options)))(
          args.prompt,
          { aspectRatio: args.aspectRatio, narration: args.narration, sound: args.sound },
        );
        const saved = await (dependencies.saveVideoToDrive || saveVideoToDrive)(
          saveId,
          { name: args.title || made.prompt.slice(0, 60), bytes: made.video, mimeType: made.mimeType },
        );
        result = textResult(
          { file: saved, aspectRatio: made.aspectRatio, model: made.model, bytes: made.video.length, narration: made.narration || "", music: Boolean(made.music) },
          `Видеото е готово (${made.aspectRatio}${made.narration ? ", с глас" : ""}${made.music ? " и музика" : ""}) и е в Google Drive: ${saved.url || saved.name}. Нищо не е публикувано.`,
        );
      } else if (name === "publish_video_to_youtube") {
        const publishId = await (dependencies.publishSessionFor || publishSessionFor)(googleSessionId);
        if (!publishId) {
          throw new GoogleDriveError(
            "YouTube качването още не е разрешено. Отвори https://cloudaicore.com/api/google/connect?add=publish и разреши.",
            403,
            "GOOGLE_SCOPE_REQUIRED",
          );
        }
        const file = await (dependencies.downloadOwnDriveVideo || downloadOwnDriveVideo)(
          await (dependencies.saveSessionFor || saveSessionFor)(googleSessionId),
          args.driveFileId,
        );
        const uploaded = await (dependencies.uploadVideoToYoutube || uploadVideoToYoutube)(publishId, {
          bytes: file.bytes,
          title: args.title || file.name,
          description: args.description || "",
          privacy: args.privacy || "private",
        });
        result = textResult(
          uploaded,
          `Видеото е качено в YouTube (${uploaded.privacy}): ${uploaded.url}`,
        );
      } else if (name === "create_gmail_draft") {
        const draft = await (dependencies.createGmailDraft || createGmailDraft)(
          googleSessionId,
          { to: args.to, subject: args.subject, body: args.body },
        );
        result = textResult(
          draft,
          `Създадена е Gmail чернова до ${draft.to}. Нищо не е изпратено.`,
        );
      } else if (name === "prepare_gmail_send") {
        const prepared = await (
          dependencies.prepareGmailDraftSend || prepareGmailDraftSend
        )({
          ownerId,
          googleSessionId,
          sessionId,
          draftId: args.draftId,
        });
        result = textResult(
          prepared,
          "Изпращането е подготвено, но имейлът не е изпратен.",
        );
      } else if (name === "prepare_gmail_delete") {
        const prepared = await (
          dependencies.prepareGmailMessageTrash || prepareGmailMessageTrash
        )({
          ownerId,
          googleSessionId,
          sessionId,
          messageId: args.messageId,
        });
        result = textResult(
          prepared,
          "Преместването в кошчето е подготвено, но не е изпълнено.",
        );
      } else if (name === "confirm_google_action") {
        const changed = await (
          dependencies.confirmGoogleAction || confirmGoogleAction
        )({
          ownerId,
          googleSessionId,
          sessionId,
          confirmationId: args.confirmationId,
        });
        result = textResult(
          changed,
          "Точното потвърдено Google действие е изпълнено.",
        );
      } else if (name === "list_google_calendar_events") {
        const events = await (
          dependencies.listCalendarEvents || listGoogleCalendarEvents
        )(googleSessionId, args.days, args.limit);
        result = textResult(
          { events, timezone: "Europe/Sofia" },
          `Намерени са ${events.length} събития.`,
        );
      } else if (name === "suggest_calendar_slots") {
        const slots = await (
          dependencies.suggestCalendarSlots || suggestGoogleCalendarSlots
        )(googleSessionId, {
          days: args.days,
          durationMinutes: args.durationMinutes,
          limit: args.limit,
          timeZone: "Europe/Sofia",
        });
        result = textResult(
          { slots, timezone: "Europe/Sofia" },
          `Предложени са ${slots.length} свободни часа.`,
        );
      } else if (name === "prepare_calendar_event") {
        const prepared = await (
          dependencies.prepareCalendarEvent || prepareCalendarEvent
        )({
          sessionId,
          googleSessionId,
          message: args.message,
        });
        result = textResult(prepared, prepared.output);
      } else if (name === "confirm_calendar_event") {
        const event = await (
          dependencies.confirmCalendarEvent || confirmCalendarEvent
        )({
          confirmationId: args.confirmationId,
          sessionId,
          googleSessionId,
        });
        result = textResult(event, formatCalendarEventResult(event));
      } else if (name === "search_google_contacts") {
        const contacts = await (
          dependencies.searchContacts || searchGoogleContacts
        )(googleSessionId, args.query, args.limit);
        result = textResult(
          { contacts },
          `Намерени са ${contacts.length} контакта.`,
        );
      } else if (name === "prepare_google_contact") {
        const prepared = await (
          dependencies.prepareGoogleContactChange || prepareGoogleContactChange
        )({
          ownerId,
          googleSessionId,
          sessionId,
          operation: args.operation,
          contact: args.contact,
        });
        result = textResult(
          prepared,
          "Промяната на контакта е подготвена, но не е изпълнена.",
        );
      }
    }

    if (!result) {
      throw Object.assign(
        new Error("MCP инструментът няма изпълним адаптер."),
        {
          code: -32601,
        },
      );
    }
    await audit({
      actor: "chatgpt-mcp",
      action: permissionAction(name),
      decision: name.startsWith("prepare_") ? "confirm" : "allow",
      outcome: "succeeded",
      resource: name,
      details: name.startsWith("confirm_")
        ? "confirmed-capability-mcp"
        : name.startsWith("prepare_")
          ? "prepared-capability-mcp"
          : "capability-mcp",
    });
    return { handled: true, result };
  };
}
