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
  evaluatePermission,
  recordAuditEvent,
} from "../services/permissionService.js";

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
  "Използвай постоянната памет естествено и само когато е свързана с темата. Не изреждай всички факти без причина.",
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
  if (image) {
    return res.status(422).json({
      error:
        "Разпознаването на снимки ще бъде добавено по-късно. Текстовият чат работи.",
    });
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

  const messages = [
    { role: "user", content: ASSISTANT_CONTEXT },
    { role: "user", content: buildMemoryContext(memories) },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: cleanMessage },
  ];

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
