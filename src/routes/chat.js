import express from "express";
import {
  buildMemoryContext,
  clearProfileMemories,
  deleteProfileMemoryByFact,
  extractForgetMemoryCommand,
  extractImplicitMemoryCandidates,
  extractPersistentMemoryCommands,
  isConfirmedForgetAllCommand,
  isForgetAllCommand,
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
  saveProfileMemory,
} from "../services/memoryService.js";
import {
  GitHubServiceError,
  isGitHubReadRequest,
} from "../services/githubService.js";
import {
  CalendarServiceError,
  isCalendarReadRequest,
} from "../services/calendarService.js";
import {
  GoogleDriveError,
  parseCookies,
} from "../services/googleDriveService.js";
import { recordAuditEvent } from "../services/permissionService.js";
import {
  isWebSearchRequest,
  WebSearchError,
} from "../services/webSearchService.js";
import {
  analyzeImage,
  ImageServiceError,
  validateImageInput,
} from "../services/imageService.js";
import {
  CapabilityError,
  executeCapability,
} from "../tools/capabilityEngine.js";
import {
  AVATAR_DEFINITION,
  PROJECT_DEFINITION,
} from "../config/projectIdentity.js";

const router = express.Router();
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_AGENT_TIMEOUT_MS = 120000;
const MEMORY_WRITE_CONFIRM_PREFIX = "Потвърждавам запис в постоянната памет:";
const MEMORY_DELETE_CONFIRM_PREFIX =
  "Потвърждавам изтриване от постоянната памет:";

async function auditAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    console.error("[Audit] Write failure:", error);
  }
}

async function saveConversationTurnBestEffort(sessionId, userText, replyText) {
  try {
    await saveConversationTurn(sessionId, userText, replyText);
    return true;
  } catch (error) {
    console.error(`[ConversationMemory] Save failure for ${sessionId}:`, error);
    return false;
  }
}

const ASSISTANT_CONTEXT = [
  "[КОНТЕКСТ И ПРАВИЛА ЗА ТОЗИ РАЗГОВОР]",
  "Ти си Synchron-X — личната AI операционна система на Радко.",
  `[КАНОНИЧНА ФОРМУЛИРОВКА] ${PROJECT_DEFINITION}`,
  AVATAR_DEFINITION,
  "Тази формулировка е по-нова и има предимство пред стари записи, които описват целия проект само като AI аватар.",
  "Паметта, инструментите, разрешенията и изборът на AI модел са отделни части на системата.",
  "Използвай само инструменти, които реално са изпълнени и разрешени. Не твърди, че услуга е свързана, ако не е проверена.",
  "Човекът, с когото разговаряш, е Радко. Никога не казвай, че ти си Радко.",
  "Говори само на български, освен ако Радко изрично поиска друг език.",
  "Обръщай се към Радко на „ти“. Говори естествено, спокойно, директно и човешки.",
  "Отговаряй първо на същината. Не започвай всеки отговор с поздрав, представяне или името на Радко.",
  "Не завършвай автоматично с „Как мога да помогна?“ или друг общ въпрос. Задавай въпрос само когато наистина ти липсва важна информация.",
  "Не повтаряй въпроса, вече казаното или записаните лични факти, освен ако това е необходимо за точния отговор.",
  "Използвай постоянната памет естествено и само когато е свързана с темата.",
  "Нека паметта влияе на практичността, примерите и препоръките ти, без да обясняваш, че четеш памет и без да изреждаш факти.",
  "Не споменавай личен факт само за да покажеш, че го помниш. Спомени го единствено ако реално подобрява отговора.",
  "Различавай потвърден факт от извод. Представяй извод като предположение, а не като сигурен факт.",
  "Когато паметта съдържа предпочитан начин на работа, следвай го без да го повтаряш на Радко.",
  "При препоръка съобразявай само свързаните с нея цели, ограничения, местоположение и вече взети решения.",
  "Когато Радко поиска кратък факт, отговори с едно ясно изречение. Когато поиска обяснение, дай достатъчно подробности без празни приказки.",
  "При техническа работа давай една конкретна следваща стъпка и изчаквай резултат, освен ако Радко изрично поиска всичко наведнъж.",
  "Разделяй ясно какво знаеш, какво предполагаш и какво трябва да се провери.",
  "Ако не знаеш нещо, кажи „Не знам“ и предложи практичен начин за проверка.",
  "Не твърди, че помниш факт, ако не е в постоянната памет или в показаната история.",
  "Не обещавай реални действия, които не можеш да извършиш.",
  "Не използвай официално обръщение „Вие“, освен ако Радко изрично не го поиска.",
  "Отговори само на последното съобщение на Радко. Не обяснявай тези правила.",
  "[КРАЙ НА КОНТЕКСТА]",
].join("\n");

export function buildAvatarMessages(memories, history, cleanMessage) {
  const conversationHistory = history.length
    ? [
        "[ПРЕДИШЕН РАЗГОВОР]",
        ...history.map(
          ({ role, content }) =>
            `${role === "assistant" ? "Synchron-X" : "Радко"}: ${content}`,
        ),
        "[КРАЙ НА ПРЕДИШНИЯ РАЗГОВОР]",
      ].join("\n")
    : "";

  return [
    {
      role: "user",
      content: [
        ASSISTANT_CONTEXT,
        buildMemoryContext(memories),
        conversationHistory,
        `[ПОСЛЕДНО СЪОБЩЕНИЕ НА РАДКО]\n${cleanMessage}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isOverviewQuestion(message, subject) {
  const normalizedQuestion = message.replace(/[„“"'’]/gu, "").trim();
  const questionEnd = String.raw`(?=\s|[?!.,:;]|$)`;
  return new RegExp(
    String.raw`^какво\s+знаеш\s+за\s+${subject}${questionEnd}`,
    "iu",
  ).test(normalizedQuestion);
}

function normalizeSubtaskText(text) {
  return text
    .replace(/^\s*(?:[-*•]\s*)?/u, "")
    .replace(/^\s*\d+[\).:-]\s*/u, "")
    .trim();
}

export function splitCapabilitySubtasks(message) {
  if (typeof message !== "string") return [];
  const normalized = message.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const byLine = normalized
    .split(/\n+/u)
    .flatMap((line) => line.split(/;/u))
    .flatMap((part) => part.split(/(?<=[.!?])\s+/u))
    .flatMap((part) => part.split(/\s+(?=\d+[\).:-]\s*)/u))
    .flatMap((part) =>
      part.split(
        /,\s+(?=(?:провери|покажи|изброй|дай|върни|виж|check|show|list)\b)/iu,
      ),
    )
    .map(normalizeSubtaskText)
    .filter(Boolean);

  return byLine.length ? byLine : [normalized];
}

export function detectCapabilityRequests(message) {
  const requests = [];
  const subtasks = splitCapabilitySubtasks(message);
  const hasGitHubContext = isGitHubReadRequest(message);
  const hasExplicitNumberedChecks =
    /намери\s*:\s*1[\).:-]\s*/iu.test(message) && subtasks.length > 1;
  for (const [index, subtask] of subtasks.entries()) {
    if (
      hasExplicitNumberedChecks &&
      index === 0 &&
      subtasks[1] &&
      /^намери\s*:\s*$/iu.test(subtasks[1])
    ) {
      continue;
    }
    if (
      /^(?:накрая\s+)?(?:запомни|запиши|помни)\b|преди\s+запис\s+в\s+паметта/iu.test(
        subtask,
      )
    ) {
      continue;
    }
    if (isCalendarReadRequest(subtask)) {
      requests.push({
        capability: "calendar.read",
        action: "calendar.read",
        message: subtask,
      });
    }
    if (
      /(?:google\s+drive|драйв|моите?\s+файлове|файловете?\s+ми)/iu.test(
        subtask,
      )
    ) {
      requests.push({
        capability: "files.read",
        action: "drive.read",
        message: subtask,
      });
    }
    if (/(?:gmail|джимейл|имейлите?\s+ми|пощата\s+ми)/iu.test(subtask)) {
      requests.push({
        capability: "mail.read",
        action: "mail.read",
        message: subtask,
      });
    }
    if (
      /(?:какво\s+помниш|провери\s+паметта|постоянната\s+(?:ми\s+)?памет)/iu.test(
        subtask,
      ) &&
      !/(?:запомни|запиши|изтрий|забрави|преди\s+запис)/iu.test(subtask)
    ) {
      requests.push({
        capability: "memory.read",
        action: "memory.read",
        message: subtask,
        scope: /(?:проекта|synchron-x|novarium)/iu.test(subtask)
          ? "project"
          : undefined,
      });
    }
    if (isWebSearchRequest(subtask)) {
      requests.push({
        capability: "web.search",
        action: "web.read",
        message: subtask,
      });
    }
    const repositoryInspectionSubtask =
      /(?:tool\s+registry|capability\s+engine|(?:кои\s+)?инструменти.*регистрирани|регистрирани\s+инструменти|разрешения.*инструмент|чатът.*capability|последно\s+поправен.*проблем)/iu.test(
        subtask,
      );
    if (
      !/(?:използва\s+успешно|кои\s+са\s+достъпни)/iu.test(subtask) &&
      (isGitHubReadRequest(subtask) ||
        (hasGitHubContext && repositoryInspectionSubtask))
    ) {
      requests.push({
        capability: "code.read",
        action: "github.read",
        message: subtask,
      });
    }
  }
  return requests;
}

function hasConfirmedMemoryWritePrefix(message) {
  if (typeof message !== "string") return false;
  const separatorIndex = message.indexOf(":");
  if (separatorIndex < 0) return false;
  const prefix = message.slice(0, separatorIndex).trim().toLowerCase();
  const expectedPrefix = MEMORY_WRITE_CONFIRM_PREFIX.toLowerCase().replace(
    /:$/u,
    "",
  );
  return prefix === expectedPrefix;
}

export function extractConfirmedMemoryWriteCommands(message) {
  if (!hasConfirmedMemoryWritePrefix(message)) return [];
  const separatorIndex = message.indexOf(":");

  const payload = message.slice(separatorIndex + 1).trim();
  const commands = extractPersistentMemoryCommands(payload);
  if (commands.length) return commands;

  const fact = payload
    .replace(/^[„“"'’]+|[„“"'’]+$/gu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  return fact ? [{ fact, scope: "personal" }] : [];
}

function hasConfirmedMemoryDeletePrefix(message) {
  if (typeof message !== "string") return false;
  const separatorIndex = message.indexOf(":");
  if (separatorIndex < 0) return false;
  return (
    message
      .slice(0, separatorIndex + 1)
      .trim()
      .toLowerCase() === MEMORY_DELETE_CONFIRM_PREFIX.toLowerCase()
  );
}

export function extractConfirmedMemoryDeleteCommand(message) {
  if (!hasConfirmedMemoryDeletePrefix(message)) return null;
  const separatorIndex = message.indexOf(":");
  const payload = message.slice(separatorIndex + 1).trim();
  return extractForgetMemoryCommand(`Изтрий от паметта: ${payload}`);
}

export async function executeDetectedCapabilities(
  message,
  executeFn,
  requests = detectCapabilityRequests(message),
  executionContext = {},
) {
  const results = [];
  for (const [index, request] of requests.entries()) {
    const requestMessage = request.message || message;
    console.info(
      `[CapabilityExecution] Start #${index + 1}/${requests.length}: ${request.capability}`,
    );
    try {
      const result = await executeFn(request.capability, {
        message: requestMessage,
        scope: request.scope,
        ...executionContext,
      });
      results.push({ status: "fulfilled", request, result });
      console.info(
        `[CapabilityExecution] Success #${index + 1}/${requests.length}: ${request.capability}`,
      );
    } catch (error) {
      results.push({ status: "rejected", request, error });
      console.info(
        `[CapabilityExecution] Failure #${index + 1}/${requests.length}: ${request.capability}`,
      );
    }
  }
  return results;
}

function capabilityLabel(capability) {
  if (capability === "calendar.read") return "календар";
  if (capability === "code.read") return "GitHub";
  if (capability === "files.read") return "Google Drive";
  if (capability === "mail.read") return "Gmail";
  if (capability === "memory.read") return "памет";
  if (capability === "web.search") return "интернет търсене";
  return capability;
}

function formatCapabilityFailureMessage(error) {
  if (
    error instanceof CalendarServiceError ||
    error instanceof GitHubServiceError ||
    error instanceof GoogleDriveError ||
    error instanceof WebSearchError
  ) {
    return error.message;
  }
  if (error instanceof CapabilityError) {
    if (
      error.code === "CAPABILITY_PERMISSION_DENIED" ||
      error.code === "CAPABILITY_CONFIRMATION_REQUIRED"
    ) {
      return error.message;
    }
    return "Инструментът за тази заявка временно не е достъпен.";
  }
  return "Избраният инструмент временно не е достъпен.";
}

export function buildMemoryReply(memoryAction) {
  if (!memoryAction) return null;
  if (memoryAction.type === "write-confirmation-required") {
    const facts = Array.isArray(memoryAction.items)
      ? memoryAction.items.map(({ fact }) => fact).filter(Boolean)
      : [];
    const content =
      facts.length === 1
        ? facts[0]
        : facts.map((fact) => `- ${fact}`).join("\n");
    return [
      "Потвърждение за запис в постоянната памет:",
      `${MEMORY_WRITE_CONFIRM_PREFIX} ${content || "<съдържание>"}`,
    ].join("\n");
  }
  if (memoryAction.type === "clear-confirmation-required") {
    return "Това ще изтрие цялата постоянна памет. За да потвърдиш, напиши точно: „Потвърждавам изтриването на цялата постоянна памет“.";
  }
  if (memoryAction.type === "delete-confirmation-required") {
    return [
      `Искаш да изтрия от постоянната памет: ${memoryAction.fact}.`,
      `За потвърждение изпрати точно: ${MEMORY_DELETE_CONFIRM_PREFIX} ${memoryAction.fact}`,
    ].join("\n");
  }
  if (memoryAction.type === "cleared") {
    return "Изчистих постоянната памет.";
  }
  if (memoryAction.type === "forgot") {
    return memoryAction.deleted
      ? `Забравих: ${memoryAction.fact}.`
      : "Не намерих такъв запис в постоянната памет.";
  }
  if (memoryAction.type === "batch") {
    const updatedCount = memoryAction.items.filter(
      (item) => item.replaced,
    ).length;
    const updatedSuffix = updatedCount
      ? `, от които ${updatedCount} обновени`
      : "";
    return [
      `Записах ${memoryAction.items.length} факта в постоянната памет${updatedSuffix}:`,
      ...memoryAction.items.map(({ fact }) => `• ${fact}`),
    ].join("\n");
  }
  if (memoryAction.type === "updated") {
    return `Поправих постоянната памет: ${memoryAction.fact}.`;
  }
  return `Запомних: ${memoryAction.fact}.`;
}

export function buildCapabilityReplies(capabilityResults) {
  const replies = [];
  for (const capabilityResult of capabilityResults) {
    if (capabilityResult.status === "fulfilled") {
      replies.push(capabilityResult.result.output);
      continue;
    }
    const { request, error } = capabilityResult;
    const message = formatCapabilityFailureMessage(error);
    replies.push(
      `Не успях да изпълня заявката за ${capabilityLabel(request.capability)}: ${message}`,
    );
  }
  if (capabilityResults.length > 1) {
    const statusByCapability = new Map();
    for (const item of capabilityResults) {
      const key = item.request.capability;
      const existing = statusByCapability.get(key);
      const name =
        item.result?.tool?.name || existing?.name || capabilityLabel(key);
      statusByCapability.set(key, {
        name,
        successful:
          item.status === "fulfilled" || Boolean(existing?.successful),
        failed: item.status === "rejected" || Boolean(existing?.failed),
      });
    }
    replies.push(
      [
        "Използвани инструменти:",
        ...[...statusByCapability.values()].map((status) => {
          const result =
            status.successful && status.failed
              ? "частично достъпен"
              : status.successful
                ? "успешно"
                : "недостъпен";
          return `• ${status.name} — ${result}`;
        }),
      ].join("\n"),
    );
  }
  return replies;
}

function extractTokenFromAgentEvent(rawEvent) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return { type: "ignore" };

  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return { type: "done" };

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new Error("Invalid JSON event received from the AI agent.");
  }
  const token = data.choices?.[0]?.delta?.content;
  return typeof token === "string" && token
    ? { type: "token", token }
    : { type: "ignore" };
}

router.post("/chat", async (req, res) => {
  const agentUrl =
    process.env.AGENT_URL ||
    "https://a4ppevqrxnzlo6t2bgcpaj3a.agents.do-ai.run";
  const agentKey = process.env.AGENT_KEY;
  const agentTimeoutMs = parsePositiveInteger(
    process.env.AGENT_TIMEOUT_MS,
    DEFAULT_AGENT_TIMEOUT_MS,
  );
  const { sessionId, message, image } = req.body || {};
  const googleSessionId =
    parseCookies(req.headers.cookie).synchron_google_session || "";
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const cleanMessage = typeof message === "string" ? message.trim() : "";

  if (!cleanSessionId) {
    return res.status(400).json({ error: "Липсва валидна сесия." });
  }
  if (!cleanMessage) {
    return res.status(400).json({ error: "Напиши съобщение." });
  }
  console.log(`[POST /chat] sessionId: ${cleanSessionId}`);

  let memories;
  let history;
  let memoryAction = null;
  let autoMemoryCount = 0;
  let memoryAvailable = true;
  const explicitMemoryIntent =
    hasConfirmedMemoryWritePrefix(cleanMessage) ||
    extractPersistentMemoryCommands(cleanMessage).length > 0 ||
    isConfirmedForgetAllCommand(cleanMessage) ||
    isForgetAllCommand(cleanMessage) ||
    hasConfirmedMemoryDeletePrefix(cleanMessage) ||
    Boolean(extractForgetMemoryCommand(cleanMessage));
  try {
    const confirmedMemoryWrite = hasConfirmedMemoryWritePrefix(cleanMessage);
    const confirmedMemoryCommands = confirmedMemoryWrite
      ? extractConfirmedMemoryWriteCommands(cleanMessage)
      : [];
    const memoryCommands = confirmedMemoryWrite
      ? confirmedMemoryCommands
      : extractPersistentMemoryCommands(cleanMessage);
    if (memoryCommands.length) {
      if (!confirmedMemoryWrite) {
        // Explicit memory writes are gated until the user confirms with the
        // dedicated confirmation prefix.
        memoryAction = {
          type: "write-confirmation-required",
          items: memoryCommands,
        };
      } else {
        const items = [];
        for (const memoryCommand of memoryCommands) {
          const saved = await saveProfileMemory(
            memoryCommand.fact,
            "explicit-chat-command",
            memoryCommand.scope,
          );
          items.push({
            fact: saved.fact,
            scope: saved.scope,
            replaced: saved.replaced,
          });
        }
        memoryAction =
          items.length === 1
            ? {
                type: items[0].replaced ? "updated" : "saved",
                fact: items[0].fact,
                scope: items[0].scope,
              }
            : { type: "batch", items };
      }
    } else if (isConfirmedForgetAllCommand(cleanMessage)) {
      const deleted = await clearProfileMemories();
      memoryAction = { type: "cleared", deleted };
    } else if (isForgetAllCommand(cleanMessage)) {
      memoryAction = { type: "clear-confirmation-required" };
    } else {
      const confirmedDelete = extractConfirmedMemoryDeleteCommand(cleanMessage);
      const forgetCommand =
        confirmedDelete || extractForgetMemoryCommand(cleanMessage);
      if (forgetCommand) {
        if (!confirmedDelete) {
          memoryAction = {
            type: "delete-confirmation-required",
            fact: forgetCommand.fact,
            scope: forgetCommand.scope,
          };
        } else {
          const deleted = await deleteProfileMemoryByFact(
            forgetCommand.fact,
            forgetCommand.scope,
          );
          memoryAction = {
            type: "forgot",
            fact: forgetCommand.fact,
            scope: forgetCommand.scope,
            deleted,
          };
        }
      }
    }
    if (!memoryAction || memoryAction.type === "write-confirmation-required") {
      const implicitMemories = extractImplicitMemoryCandidates(cleanMessage);
      for (const memory of implicitMemories) {
        await saveProfileMemory(
          memory.fact,
          "automatic-high-confidence",
          memory.scope,
        );
        autoMemoryCount += 1;
      }
    }
    [memories, history] = await Promise.all([
      listProfileMemories(),
      listConversationMessages(cleanSessionId),
    ]);
  } catch (error) {
    console.error(`[Memory] Failure for ${cleanSessionId}:`, error);
    if (explicitMemoryIntent) {
      return res.status(503).json({
        error:
          "Постоянната памет временно не е достъпна. Нищо не беше записано или изтрито.",
      });
    }
    memories = [];
    history = [];
    memoryAvailable = false;
  }

  const messages = buildAvatarMessages(memories, history, cleanMessage);

  if (image) {
    try {
      validateImageInput(image);
    } catch (error) {
      const status = error instanceof ImageServiceError ? error.status : 400;
      return res.status(status).json({ error: error.message });
    }
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const sendEvent = (event, data) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };
  const sendHeartbeat = () => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  };

  if (image) {
    try {
      const fullReply = await analyzeImage({
        image,
        prompt: cleanMessage,
        context: messages[0].content,
      });
      await saveConversationTurnBestEffort(
        cleanSessionId,
        cleanMessage,
        fullReply,
      );
      await auditAction({
        action: "image.read",
        decision: "allow",
        outcome: "succeeded",
        resource: image.name || "chat-image",
        sessionId: cleanSessionId,
      });
      sendEvent("token", { token: fullReply });
      sendEvent("done", { ok: true, tool: "vision" });
    } catch (error) {
      console.error(`[Vision] Failure for ${cleanSessionId}:`, error);
      sendEvent("error", {
        status: error instanceof ImageServiceError ? error.status : 502,
        message:
          error instanceof ImageServiceError
            ? error.message
            : "Снимката не можа да бъде разпозната. Опитай отново.",
      });
    }
    res.end();
    return;
  }

  const memoryReply = buildMemoryReply(memoryAction);
  if (memoryAction) {
    const isDeleteAction =
      memoryAction.type === "cleared" ||
      memoryAction.type === "forgot" ||
      memoryAction.type === "delete-confirmation-required" ||
      memoryAction.type === "clear-confirmation-required";
    const isWriteConfirmationRequest =
      memoryAction.type === "write-confirmation-required";
    const memoryAuditAction = isDeleteAction ? "memory.delete" : "memory.write";
    await auditAction({
      action: memoryAuditAction,
      decision:
        memoryAction.type === "clear-confirmation-required" ||
        memoryAction.type === "delete-confirmation-required" ||
        isWriteConfirmationRequest
          ? "confirm"
          : isDeleteAction
            ? "confirmed"
            : "allow",
      outcome:
        memoryAction.type === "clear-confirmation-required" ||
        memoryAction.type === "delete-confirmation-required" ||
        isWriteConfirmationRequest
          ? "requested"
          : "succeeded",
      resource: "profile-memory",
      details: memoryAction.type,
      sessionId: cleanSessionId,
    });
  }

  const isProfileOverviewQuestion = isOverviewQuestion(cleanMessage, "мен");
  const isProjectOverviewQuestion = isOverviewQuestion(
    cleanMessage,
    "(?:проекта|synchron-x)",
  );
  if (isProfileOverviewQuestion || isProjectOverviewQuestion) {
    const requestedScope = isProjectOverviewQuestion ? "project" : "personal";
    const scopedMemories = memories.filter(
      (memory) => (memory.scope || "personal") === requestedScope,
    );
    const heading = isProjectOverviewQuestion
      ? "Знам следното за проекта:"
      : "Знам следното за теб:";
    const emptyReply = isProjectOverviewQuestion
      ? "Все още нямам записани факти за проекта."
      : "Все още нямам записани лични факти за теб.";
    const fullReply = scopedMemories.length
      ? [heading, ...scopedMemories.map(({ fact }) => `• ${fact}`)].join("\n")
      : emptyReply;

    await saveConversationTurnBestEffort(
      cleanSessionId,
      cleanMessage,
      fullReply,
    );
    sendEvent("token", { token: fullReply });
    sendEvent("done", { ok: true, memoryCount: scopedMemories.length });
    console.info(
      `[Chat] Response completed (memory overview) for ${cleanSessionId}`,
    );
    res.end();
    return;
  }

  const detectedCapabilityRequests = detectCapabilityRequests(cleanMessage);
  console.info(
    `[Chat] Detected ${detectedCapabilityRequests.length} capability subtasks for ${cleanSessionId}: ${detectedCapabilityRequests
      .map((request, index) => `#${index + 1}:${request.capability}`)
      .join(", ")}`,
  );
  const capabilityResults = await executeDetectedCapabilities(
    cleanMessage,
    executeCapability,
    detectedCapabilityRequests,
    {
      googleSessionId,
      sessionId: cleanSessionId,
    },
  );
  const capabilityReplies = buildCapabilityReplies(capabilityResults);
  if (capabilityResults.length) {
    for (const [index, capabilityResult] of capabilityResults.entries()) {
      if (capabilityResult.status === "fulfilled") {
        const { request, result } = capabilityResult;
        console.info(
          `[Chat] Subtask result #${index + 1}/${capabilityResults.length}: ${request.capability} -> success`,
        );
        await auditAction({
          action: request.action,
          decision: result.permission.decision,
          outcome: "succeeded",
          resource: result.tool.id,
          sessionId: cleanSessionId,
        });
      } else {
        const { request, error } = capabilityResult;
        console.info(
          `[Chat] Subtask result #${index + 1}/${capabilityResults.length}: ${request.capability} -> failed`,
        );
        await auditAction({
          action: request.action,
          decision: "deny",
          outcome: "failed",
          resource: request.capability,
          details: error?.code || error?.message || "unknown_error",
          sessionId: cleanSessionId,
        });
      }
    }
  }

  if (memoryReply || capabilityReplies.length) {
    const fullReply = [...capabilityReplies, memoryReply]
      .filter(Boolean)
      .join("\n\n");
    await saveConversationTurnBestEffort(
      cleanSessionId,
      cleanMessage,
      fullReply,
    );
    sendEvent("token", { token: fullReply });
    sendEvent("done", {
      ok: true,
      memoryUpdated: Boolean(memoryAction),
      capabilities: capabilityResults.map(({ request }) => request.capability),
      mode: capabilityResults.length ? "read-only" : undefined,
      memoryAvailable,
    });
    console.info(
      `[Chat] Response completed (memory/capabilities shortcut) for ${cleanSessionId}`,
    );
    res.end();
    return;
  }

  if (!agentKey) {
    sendEvent("error", {
      status: 503,
      message:
        "AI разговорът временно не е конфигуриран. Независимите инструменти остават достъпни.",
    });
    res.end();
    return;
  }

  const abortController = new AbortController();
  let timedOut = false;
  let heartbeatInterval;
  let timeoutHandle;
  const cleanup = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };
  const abortUpstream = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };

  res.on("close", () => {
    cleanup();
    if (!res.writableEnded) abortUpstream();
  });
  sendHeartbeat();
  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortUpstream();
  }, agentTimeoutMs);

  try {
    const agentRes = await fetch(`${agentUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ messages, stream: true }),
      signal: abortController.signal,
    });

    if (!agentRes.ok) {
      const body = await agentRes.text();
      console.error(`[Agent] ${agentRes.status}:`, body || "<empty>");
      sendEvent("error", {
        status: agentRes.status,
        message: `AI агентът върна грешка ${agentRes.status}. Опитай отново.`,
      });
      return;
    }
    if (!agentRes.body) throw new Error("Empty AI response stream.");

    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullReply = "";

    const processEvents = () => {
      buffer = buffer.replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const rawEvent of events) {
        if (!rawEvent.trim()) continue;
        const parsed = extractTokenFromAgentEvent(rawEvent);
        if (parsed.type === "token") {
          fullReply += parsed.token;
          if (!sendEvent("token", { token: parsed.token })) {
            abortUpstream();
            return false;
          }
        }
      }
      return true;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (!processEvents()) return;
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = extractTokenFromAgentEvent(buffer);
      if (parsed.type === "token") {
        fullReply += parsed.token;
        sendEvent("token", { token: parsed.token });
      }
    }
    if (!fullReply.trim()) {
      throw new Error("AI agent completed without returning text.");
    }

    await saveConversationTurnBestEffort(
      cleanSessionId,
      cleanMessage,
      fullReply,
    );
    sendEvent("done", {
      ok: true,
      memoryCount: memories.length,
      autoMemoryCount,
      memoryAvailable,
    });
    console.log(`[Agent] Stream success for ${cleanSessionId}`);
    console.info(
      `[Chat] Response completed (agent stream) for ${cleanSessionId}`,
    );
  } catch (error) {
    if (abortController.signal.aborted && !timedOut) return;
    console.error(`[Agent] Failure for ${cleanSessionId}:`, error);
    sendEvent("error", {
      status: timedOut ? 504 : 502,
      message: timedOut
        ? "AI агентът се забави прекалено. Опитай отново."
        : "Връзката с AI агента беше прекъсната. Опитай отново.",
    });
  } finally {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

export default router;
