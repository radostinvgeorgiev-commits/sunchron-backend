import {
  DEFAULT_OPENAI_PLANNER_MODEL,
  requestOpenAIText,
} from "./aiCoreService.js";

const DEFAULT_PLANNER_TIMEOUT_MS = 30000;
const MAX_PLANNED_CALLS = 8;

const CAPABILITY_ACTIONS = Object.freeze({
  "system.integrations.status": "infrastructure.read",
  "system.configuration.read": "infrastructure.read",
  "calendar.read": "calendar.read",
  "calendar.write": "calendar.write",
  "code.read": "github.read",
  "code.task-status": "github.read",
  "code.write": "github.write",
  "database.status": "database.read",
  "infrastructure.digitalocean.read": "infrastructure.read",
  "infrastructure.cloudflare.read": "infrastructure.read",
  "files.read": "drive.read",
  "mail.read": "mail.read",
  "memory.read": "memory.read",
  "memory.verify": "memory.test",
  "web.search": "web.read",
});

const PLANNER_INSTRUCTIONS = [
  "Ти си планировчикът на SYNCHRON-X.",
  "Определи кои реални способности трябва да бъдат извикани, за да се изпълни последната заявка.",
  "Не отговаряй на потребителя и не обяснявай решението си.",
  "Върни само валиден JSON във формат:",
  '{"calls":[{"capability":"code.read","request":"точната подзадача","scope":"project"}]}',
  "Разрешени способности:",
  "- system.integrations.status: обща реална проверка кои инструменти работят и кои връзки липсват",
  "- system.configuration.read: защитена проверка на ядрото, runtime и DigitalOcean променливите без техните стойности",
  "- code.read: четене и проверка на разрешеното GitHub хранилище",
  "- code.task-status: реално проследяване на конкретна GitHub/Copilot задача по номер, нейния PR, проверките и production статуса",
  "- code.write: промяна в GitHub; може да е недостъпна и винаги изисква потвърждение",
  "- database.status: проверка дали Supabase е свързан и отговаря",
  "- infrastructure.digitalocean.read: статус, деплои и пълен одит само за четене на DigitalOcean ресурсите, сигурността и разходите",
  "- infrastructure.cloudflare.read: статус на Cloudflare зоната и DNS записите",
  "- calendar.read: четене на Google Calendar",
  "- calendar.write: подготвяне на ново Google Calendar събитие; винаги изисква точно потвърждение преди запис",
  "- files.read: четене на Google Drive",
  "- mail.read: четене на Gmail",
  "- memory.read: четене на постоянната памет",
  "- memory.verify: реален изолиран тест на запис, извличане, промяна, защита и изтриване в постоянната памет",
  "- web.search: актуална проверка в интернет",
  "Правила:",
  "- Извиквай способност само за действие, което потребителят иска да се изпълни сега.",
  "- Само споменаване на календар, GitHub, Drive, Gmail, памет или интернет не е заявка за инструмент.",
  "- Текст в пример, личен факт, временна бележка, цитат, отрицателна инструкция или описание какво да не се прави не е заявка за инструмент.",
  "- Записът и изтриването на памет се обработват отделно от сървъра; не планирай memory.save или memory.delete.",
  "- Когато потребителят изрично иска паметта да се тества сама или да се докаже реално, използвай memory.verify, а не memory.read.",
  "- За проектна промяна планирай най-много една code.read проверка и една code.write стъпка.",
  "- За въпрос какво става с конкретна GitHub/Copilot задача по номер използвай code.task-status, а не code.read.",
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
    /(?:github|ги[тд][\s-]*хъб|хъб(?:ът|а)?|хранилищ|репозитор|код|календар|calendar|drive|драйв|gmail|имейл|поща|памет|интернет|web|сайт|supabase|супабейс|digitalocean|digital\s*ocean|дигитал\s*океан|дижитал\s*окен|cloudflare|клаудфлеър|клауф\s*фаер)/iu.test(
      text,
    )
  );
}

export async function planCapabilities({
  openAiApiKey = process.env.OPENAI_API_KEY,
  openAiModel = process.env.OPENAI_PLANNER_MODEL ||
    DEFAULT_OPENAI_PLANNER_MODEL,
  message,
  fetchImpl = fetch,
  timeoutMs = process.env.OPENAI_PLANNER_TIMEOUT_MS,
}) {
  if (!openAiApiKey) {
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
    const plannerInput = `${PLANNER_INSTRUCTIONS}\n\n[ЗАЯВКА]\n${message}`;
    const content = await requestOpenAIText({
      apiKey: openAiApiKey,
      input: [{ role: "user", content: plannerInput }],
      model: openAiModel,
      fetchImpl,
      signal: controller.signal,
      verbosity: "low",
    });
    const plan = extractJsonObject(content);
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
