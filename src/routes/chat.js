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
  answerGitHubReadRequest,
  GitHubServiceError,
  isGitHubReadRequest,
} from "../services/githubService.js";
import {
  answerCalendarReadRequest,
  CalendarServiceError,
  isCalendarReadRequest,
} from "../services/calendarService.js";
import {
  evaluatePermission,
  recordAuditEvent,
} from "../services/permissionService.js";
import {
  analyzeImage,
  ImageServiceError,
  validateImageInput,
} from "../services/imageService.js";

const router = express.Router();
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_AGENT_TIMEOUT_MS = 120000;

async function auditAction(event) {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    console.error("[Audit] Write failure:", error);
  }
}

const ASSISTANT_CONTEXT = [
  "[КОНТЕКСТ И ПРАВИЛА ЗА ТОЗИ РАЗГОВОР]",
  "Ти си Synchron-X — личният AI асистент и AI аватар на Радко.",
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
        ...history.map(({ role, content }) =>
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
  const cleanSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  const cleanMessage = typeof message === "string" ? message.trim() : "";

  if (!cleanSessionId) {
    return res.status(400).json({ error: "Липсва валидна сесия." });
  }
  if (!cleanMessage) {
    return res.status(400).json({ error: "Напиши съобщение." });
  }
  if (!agentKey) {
    return res.status(500).json({ error: "AI връзката не е конфигурирана." });
  }

  console.log(`[POST /chat] sessionId: ${cleanSessionId}`);

  let memories;
  let history;
  let memoryAction = null;
  let autoMemoryCount = 0;
  try {
    const memoryCommands = extractPersistentMemoryCommands(cleanMessage);
    if (memoryCommands.length) {
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
    } else if (isConfirmedForgetAllCommand(cleanMessage)) {
      const deleted = await clearProfileMemories();
      memoryAction = { type: "cleared", deleted };
    } else if (isForgetAllCommand(cleanMessage)) {
      memoryAction = { type: "clear-confirmation-required" };
    } else {
      const forgetCommand = extractForgetMemoryCommand(cleanMessage);
      if (forgetCommand) {
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
    if (!memoryAction) {
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
    return res.status(503).json({
      error:
        "Постоянната памет временно не е достъпна. Нищо не беше записано.",
    });
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
      await saveConversationTurn(cleanSessionId, cleanMessage, fullReply);
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

  if (memoryAction) {
    let fullReply;
    if (memoryAction.type === "clear-confirmation-required") {
      fullReply =
        "Това ще изтрие цялата постоянна памет. За да потвърдиш, напиши точно: „Потвърждавам изтриването на цялата постоянна памет“.";
    } else if (memoryAction.type === "cleared") {
      fullReply = "Изчистих постоянната памет.";
    } else if (memoryAction.type === "forgot") {
      fullReply = memoryAction.deleted
        ? `Забравих: ${memoryAction.fact}.`
        : "Не намерих такъв запис в постоянната памет.";
    } else if (memoryAction.type === "batch") {
      const updatedCount = memoryAction.items.filter(
        (item) => item.replaced,
      ).length;
      const updatedSuffix = updatedCount
        ? `, от които ${updatedCount} обновени`
        : "";
      fullReply = [
        `Записах ${memoryAction.items.length} факта в постоянната памет${updatedSuffix}:`,
        ...memoryAction.items.map(({ fact }) => `• ${fact}`),
      ].join("\n");
    } else if (memoryAction.type === "updated") {
      fullReply = `Поправих постоянната памет: ${memoryAction.fact}.`;
    } else {
      fullReply = `Запомних: ${memoryAction.fact}.`;
    }

    await saveConversationTurn(cleanSessionId, cleanMessage, fullReply);
    const isDeleteAction =
      memoryAction.type === "cleared" ||
      memoryAction.type === "forgot" ||
      memoryAction.type === "clear-confirmation-required";
    await auditAction({
      action: isDeleteAction ? "memory.delete" : "memory.write",
      decision:
        memoryAction.type === "clear-confirmation-required"
          ? "confirm"
          : isDeleteAction
            ? "confirmed"
            : "allow",
      outcome:
        memoryAction.type === "clear-confirmation-required"
          ? "requested"
          : "succeeded",
      resource: "profile-memory",
      details: memoryAction.type,
      sessionId: cleanSessionId,
    });
    sendEvent("token", { token: fullReply });
    sendEvent("done", { ok: true, memoryUpdated: true });
    res.end();
    return;
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
      ? [
          heading,
          ...scopedMemories.map(({ fact }) => `• ${fact}`),
        ].join("\n")
      : emptyReply;

    await saveConversationTurn(cleanSessionId, cleanMessage, fullReply);
    sendEvent("token", { token: fullReply });
    sendEvent("done", { ok: true, memoryCount: scopedMemories.length });
    res.end();
    return;
  }

  try {
    const wantsCalendarRead = isCalendarReadRequest(cleanMessage);
    const calendarPermission = wantsCalendarRead
      ? evaluatePermission("calendar.read")
      : null;
    if (calendarPermission && calendarPermission.decision !== "allow") {
      throw new CalendarServiceError(
        calendarPermission.reason,
        403,
        "PERMISSION_DENIED",
      );
    }
    const calendarReply = wantsCalendarRead
      ? await answerCalendarReadRequest(cleanMessage)
      : null;
    if (calendarReply) {
      await saveConversationTurn(cleanSessionId, cleanMessage, calendarReply);
      await auditAction({
        action: "calendar.read",
        decision: calendarPermission.decision,
        outcome: "succeeded",
        resource: "chat-tool",
        sessionId: cleanSessionId,
      });
      sendEvent("token", { token: calendarReply });
      sendEvent("done", { ok: true, tool: "calendar", mode: "read-only" });
      res.end();
      return;
    }

    const wantsGitHubRead = isGitHubReadRequest(cleanMessage);
    const githubPermission = wantsGitHubRead
      ? evaluatePermission("github.read")
      : null;
    if (githubPermission && githubPermission.decision !== "allow") {
      await auditAction({
        action: "github.read",
        decision: githubPermission.decision,
        outcome: "blocked",
        resource: "chat-tool",
        sessionId: cleanSessionId,
      });
      throw new GitHubServiceError(
        githubPermission.reason,
        403,
        "PERMISSION_DENIED",
      );
    }

    const githubReply = wantsGitHubRead
      ? await answerGitHubReadRequest(cleanMessage)
      : null;
    if (githubReply) {
      await saveConversationTurn(cleanSessionId, cleanMessage, githubReply);
      await auditAction({
        action: "github.read",
        decision: githubPermission.decision,
        outcome: "succeeded",
        resource: "chat-tool",
        sessionId: cleanSessionId,
      });
      sendEvent("token", { token: githubReply });
      sendEvent("done", { ok: true, tool: "github", mode: "read-only" });
      res.end();
      return;
    }
  } catch (error) {
    const message =
      error instanceof GitHubServiceError
        ? error.message
        : "GitHub модулът временно не е достъпен.";
    sendEvent("error", { message, tool: "github" });
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

    await saveConversationTurn(cleanSessionId, cleanMessage, fullReply);
    sendEvent("done", {
      ok: true,
      memoryCount: memories.length,
      autoMemoryCount,
    });
    console.log(`[Agent] Stream success for ${cleanSessionId}`);
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
