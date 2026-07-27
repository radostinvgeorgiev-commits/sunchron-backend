const DEFAULT_PLANNER_TIMEOUT_MS = 30000;
const MAX_PLANNED_CALLS = 8;

const CAPABILITY_ACTIONS = Object.freeze({
  "calendar.read": "calendar.read",
  "code.read": "github.read",
  "code.write": "github.write",
  "files.read": "drive.read",
  "mail.read": "mail.read",
  "memory.read": "memory.read",
  "web.search": "web.read",
});

const PLANNER_INSTRUCTIONS = [
  "Ти си планировчикът на SYNCHRON-X.",
  "Определи кои реални способности трябва да бъдат извикани, за да се изпълни последната заявка.",
  "Не отговаряй на потребителя и не обяснявай решението си.",
  "Върни само валиден JSON във формат:",
  '{"calls":[{"capability":"code.read","request":"точната подзадача","scope":"project"}]}',
  "Разрешени способности:",
  "- code.read: четене и проверка на разрешеното GitHub хранилище",
  "- code.write: промяна в GitHub; може да е недостъпна и винаги изисква потвърждение",
  "- calendar.read: четене на Google Calendar",
  "- files.read: четене на Google Drive",
  "- mail.read: четене на Gmail",
  "- memory.read: четене на постоянната памет",
  "- web.search: актуална проверка в интернет",
  "Правила:",
  "- Извиквай способност само за действие, което потребителят иска да се изпълни сега.",
  "- Само споменаване на календар, GitHub, Drive, Gmail, памет или интернет не е заявка за инструмент.",
  "- Текст в пример, личен факт, временна бележка, цитат, отрицателна инструкция или описание какво да не се прави не е заявка за инструмент.",
  "- Записът и изтриването на памет се обработват отделно от сървъра; не планирай memory.save или memory.delete.",
  "- За проектна промяна планирай най-много една code.read проверка и една code.write стъпка.",
  "- Не дублирай една и съща способност за една и съща подзадача.",
  '- Ако не е нужен инструмент, върни {"calls":[]}.',
].join("\n");

export class AgentPlannerError extends Error {
  constructor(message, code = "AGENT_PLANNER_ERROR") {
    super(message);
    this.name = "AgentPlannerError";
    this.code = code;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractAssistantContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item?.text === "string"
            ? item.text
            : "",
      )
      .join("");
  }
  return "";
}

function extractJsonObject(content) {
  const cleanContent = String(content || "")
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const firstBrace = cleanContent.indexOf("{");
  const lastBrace = cleanContent.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new AgentPlannerError(
      "AI планировчикът не върна JSON план.",
      "AGENT_PLANNER_INVALID_RESPONSE",
    );
  }
  try {
    return JSON.parse(cleanContent.slice(firstBrace, lastBrace + 1));
  } catch {
    throw new AgentPlannerError(
      "AI планировчикът върна невалиден JSON план.",
      "AGENT_PLANNER_INVALID_JSON",
    );
  }
}

function cleanScope(value) {
  return value === "personal" || value === "project" ? value : undefined;
}

export function sanitizeCapabilityPlan(plan, originalMessage) {
  const calls = Array.isArray(plan?.calls) ? plan.calls : [];
  const requests = [];
  const seen = new Set();

  for (const call of calls.slice(0, MAX_PLANNED_CALLS)) {
    const capability =
      typeof call?.capability === "string" ? call.capability.trim() : "";
    const action = CAPABILITY_ACTIONS[capability];
    if (!action) continue;

    const plannedRequest =
      typeof call?.request === "string" ? call.request.trim() : "";
    const requestMessage =
      capability === "code.write"
        ? originalMessage
        : plannedRequest || originalMessage;
    const scope = cleanScope(call?.scope);
    const key = `${capability}\u0000${requestMessage}\u0000${scope || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    requests.push({
      capability,
      action,
      message: requestMessage,
      ...(scope ? { scope } : {}),
    });
  }

  return requests;
}

export function shouldUseAgentPlanner(message, fallbackRequests = []) {
  if (Array.isArray(fallbackRequests) && fallbackRequests.length > 0) {
    return true;
  }
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return false;
  return (
    /(?:^|\s)(?:изпълни|направи|провери|покажи|намери|прочети|потърси|обнови|промени|редактирай|създай|свържи|изпрати|резервирай)\b/iu.test(
      text,
    ) &&
    /(?:github|хранилищ|репозитор|код|календар|calendar|drive|драйв|gmail|имейл|поща|памет|интернет|web|сайт)/iu.test(
      text,
    )
  );
}

export async function planCapabilities({
  agentUrl,
  agentKey,
  message,
  fetchImpl = fetch,
  timeoutMs = process.env.AGENT_PLANNER_TIMEOUT_MS,
}) {
  if (!agentUrl || !agentKey) {
    throw new AgentPlannerError(
      "AI планировчикът не е конфигуриран.",
      "AGENT_PLANNER_NOT_CONFIGURED",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    parsePositiveInteger(timeoutMs, DEFAULT_PLANNER_TIMEOUT_MS),
  );

  try {
    const response = await fetchImpl(`${agentUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: `${PLANNER_INSTRUCTIONS}\n\n[ЗАЯВКА]\n${message}`,
          },
        ],
        stream: false,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AgentPlannerError(
        `AI планировчикът върна грешка ${response.status}.`,
        "AGENT_PLANNER_UPSTREAM_ERROR",
      );
    }

    const data = await response.json();
    const plan = extractJsonObject(extractAssistantContent(data));
    return sanitizeCapabilityPlan(plan, message);
  } catch (error) {
    if (error instanceof AgentPlannerError) throw error;
    if (error?.name === "AbortError") {
      throw new AgentPlannerError(
        "AI планировчикът не отговори навреме.",
        "AGENT_PLANNER_TIMEOUT",
      );
    }
    throw new AgentPlannerError(
      "AI планировчикът временно не е достъпен.",
      "AGENT_PLANNER_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}
