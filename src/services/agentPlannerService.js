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
  "infrastructure.googlecloud.read": "infrastructure.read",
  "infrastructure.googlecloud.diagnostics.read": "infrastructure.read",
  "infrastructure.googlecloud.write": "infrastructure.write",
  "files.read": "drive.read",
  "mail.read": "mail.read",
  "memory.read": "memory.read",
  "memory.verify": "memory.test",
  "tasks.read": "tasks.read",
  "tasks.draft": "tasks.draft",
  "tasks.progress": "tasks.read",
  "web.search": "web.read",
});

const PLANNER_INSTRUCTIONS = [
  "Ти си планировчикът на AI CORE.",
  "Определи кои реални способности трябва да бъдат извикани, за да се изпълни последната заявка.",
  "Не отговаряй на потребителя и не обяснявай решението си.",
  "Върни само валиден JSON във формат:",
  '{"calls":[{"capability":"code.read","request":"точната подзадача","scope":"project"}]}',
  "Разрешени способности:",
  "- system.integrations.status: обща реална проверка кои инструменти работят и кои връзки липсват",
  "- system.configuration.read: защитена проверка на ядрото и Google Cloud runtime настройките без техните стойности",
  "- code.read: четене и проверка на разрешеното GitHub хранилище",
  "- code.task-status: реално проследяване на конкретна GitHub задача или Pull Request по номер, проверките и production статуса",
  "- code.write: промяна в GitHub; може да е недостъпна и винаги изисква потвърждение",
  "- database.status: проверка дали Supabase е свързан и отговаря",
  "- infrastructure.googlecloud.read: реална проверка на текущия Google Cloud / Cloud Run runtime без стойности на secrets",
  "- infrastructure.googlecloud.diagnostics.read: bounded read-only проверка на health, readiness, MCP, Cloud Run и Cloud Build trigger-а",
  "- infrastructure.googlecloud.write: точна IAM или Cloud Run service identity промяна; винаги изисква отделно потвърждение",
  "- calendar.read: четене на Google Calendar",
  "- calendar.write: подготвяне на ново Google Calendar събитие или напомняне; винаги изисква точно потвърждение преди запис",
  "- files.read: четене на Google Drive",
  "- mail.read: четене на Gmail",
  "- memory.read: четене на постоянната памет",
  "- memory.verify: реален изолиран тест на запис, извличане, промяна, защита и изтриване в постоянната памет",
  "- tasks.read: показване на запазените задачи",
  "- tasks.progress: показване само на незавършените задачи",
  "- tasks.draft: създаване на нова чернова на задача в постоянния Task Journal",
  "- web.search: актуална проверка в интернет",
  "Правила:",
  "- Извиквай способност само за действие, което потребителят иска да се изпълни сега.",
  "- Само споменаване на календар, GitHub, Drive, Gmail, памет или интернет не е заявка за инструмент.",
  "- Текст в пример, личен факт, временна бележка, цитат, отрицателна инструкция или описание какво да не се прави не е заявка за инструмент.",
  "- При „само за четене“, „read-only“ или обща забрана да се правят промени никога не планирай code.write.",
  "- Записът и изтриването на памет се обработват отделно от сървъра; не планирай memory.save или memory.delete.",
  "- Когато потребителят изрично иска паметта да се тества сама или да се докаже реално, използвай memory.verify, а не memory.read.",
  "- За проектна промяна планирай най-много една code.read проверка и една code.write стъпка.",
  "- За въпрос какво става с конкретна GitHub задача или Pull Request по номер използвай code.task-status, а не code.read.",
  "- Не дублирай една и съща способност за една и съща подзадача.",
  '- Ако не е нужен инструмент, върни {"calls":[]}.',
].join("\n");

export function hasExplicitReadOnlyBoundary(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return false;
  return (
    /(?:само\s+за\s+четене|само\s+прочети|read[\s-]*only)/iu.test(text) ||
    /(?:без|никакви?)\s+(?:кодови\s+)?промени/iu.test(text) ||
    /(?:покажи|провери)\s+само\s+(?:статуса|статус|състоянието)/iu.test(
      text,
    ) ||
    /(?:^|[.!?]\s*)не\s+(?:прави|извършвай)\s+(?:никакви\s+)?промени(?=\s*[.!?]?\s*$)/iu.test(
      text,
    )
  );
}

export function isReadOnlyIntegrationStatusRequest(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return false;

  const mentionsIntegration =
    /(?:инструмент(?:ите)?|връзк(?:и|ите)|интеграци(?:и|ите)|ai\s*(?:двигател(?:и|ите)?|доставчик(?:и|ите)?|provider(?:s)?)|openai|gemini|grok|google\s*drive|драйв|gmail|джимейл|google\s*calendar|календар)/iu.test(
      text,
    );
  const asksForStatus =
    /(?:статус|състояние|конфигуриран|достъпен|достъпни|активен|активни|свързан|свързани|работи|работят|мога\s+да\s+(?:ги\s+)?използвам|кои\s+.*(?:работят|достъпни|активни))/iu.test(
      text,
    );
  const asksForData =
    /(?:покажи|прочети|намери|изброй|търси|анализирай).{0,45}(?:файлове|писма|имейли|съобщения|събития|срещи)/iu.test(
      text,
    ) &&
    !/(?:само\s+(?:статуса|статус|състоянието)|без\s+да\s+(?:четеш|показваш|отваряш))/iu.test(
      text,
    );

  return mentionsIntegration && asksForStatus && !asksForData;
}

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
  const statusOnlyRequest =
    isReadOnlyIntegrationStatusRequest(originalMessage);

  for (const call of calls.slice(0, MAX_PLANNED_CALLS)) {
    const capability =
      typeof call?.capability === "string" ? call.capability.trim() : "";
    const action = CAPABILITY_ACTIONS[capability];
    if (!action) continue;
    if (
      statusOnlyRequest &&
      capability !== "system.integrations.status"
    ) {
      continue;
    }
    if (
      capability === "code.write" &&
      hasExplicitReadOnlyBoundary(originalMessage)
    ) {
      continue;
    }

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
    /(?:^|\s)(?:изпълни|направи|провери|покажи|намери|прочети|потърси|обнови|подобри|промени|редактирай|създай|свържи|изпрати|резервирай|напомни|improve)(?=\s|:|$)/iu.test(
      text,
    ) &&
    /(?:github|ги[тд][\s-]*хъб|хъб(?:ът|а)?|хранилищ|репозитор|код|календар|calendar|напомни|напомнян|drive|драйв|gmail|имейл|поща|памет|задач|task|интернет|web|сайт|supabase|супабейс|google\s*cloud|cloud\s*run|гуг[ъал]+\s*клауд|гуг[ъал]+\s*конзол|ai\s*(?:двигател|доставчик|provider)|openai|gemini|grok)/iu.test(
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
