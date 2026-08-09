const WORK_MODES = new Set(["chat", "work"]);
const WORK_PETS = Object.freeze({
  robot: "Кори",
  drop: "Капка",
  spark: "Искра",
  owl: "Бухал",
  rock: "Скала",
  cat: "Мяу",
});

const AGENT_ROLES = Object.freeze({
  general: {
    label: "Универсален помощник",
    guidance:
      "Подреждай задачата, използвай само разрешените инструменти и върни ясен проверим резултат.",
  },
  researcher: {
    label: "Изследовател",
    guidance:
      "Проверявай източниците, разделяй фактите от изводите и посочвай какво остава непроверено.",
  },
  organizer: {
    label: "Организатор",
    guidance:
      "Разделяй работата на малки стъпки, използвай календара само когато задачата го изисква, следи напредъка и спирай преди рисково външно действие.",
  },
  documents: {
    label: "Документи и поща",
    guidance:
      "Работи прецизно с разрешените файлове, документи и съобщения. Разграничавай прочетеното съдържание от предложенията и не изпращай нищо без потвърждение.",
  },
  builder: {
    label: "Създател на проекти",
    guidance:
      "Изготвяй използваеми резултати, планове и файлово съдържание, но не твърди, че код или файл е записан без реален изпълним инструмент.",
  },
  coder: {
    label: "Codex разработчик",
    guidance:
      "Анализирай реалния код в изолирана област. Не твърди, че промяна е записана, преди да има потвърден write процес.",
  },
});

const AGENT_ENGINES = Object.freeze({
  "ai-core": { label: "AI CORE" },
  codex: { label: "Codex" },
});

const PROJECT_RUN_STATUSES = new Set([
  "complete",
  "ready_for_next_step",
  "blocked",
]);

const AGENT_MODELS = Object.freeze({
  auto: { label: "Автоматичен", apiModel: null },
  "gpt-5.6-sol": {
    label: "GPT-5.6 Sol",
    provider: "openai",
    apiModel: "gpt-5.6-sol",
  },
  "gpt-5.6-terra": {
    label: "GPT-5.6 Terra",
    provider: "openai",
    apiModel: "gpt-5.6-terra",
  },
  "gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    provider: "openai",
    apiModel: "gpt-5.6-luna",
  },
  "gemini-2.5-flash": {
    label: "Gemini 2.5 Flash",
    provider: "gemini",
    apiModel: "gemini-2.5-flash",
  },
  "grok-3-mini": {
    label: "Grok 3 Mini",
    provider: "grok",
    apiModel: "grok-3-mini",
  },
  "claude-sonnet-5": {
    label: "Claude Sonnet 5",
    provider: "anthropic",
    apiModel: "claude-sonnet-5",
  },
});

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeInteractionMode(value) {
  return WORK_MODES.has(value) ? value : "chat";
}

function sanitizeProjectRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = cleanText(value.summary, 4000);
  const nextStep = cleanText(value.nextStep, 1200);
  if (!summary && !nextStep) return null;
  return Object.freeze({
    sequence: Math.max(
      0,
      Math.min(Number.parseInt(value.sequence, 10) || 0, 999999),
    ),
    status: PROJECT_RUN_STATUSES.has(value.status)
      ? value.status
      : "ready_for_next_step",
    summary,
    evidence: Object.freeze(
      (Array.isArray(value.evidence) ? value.evidence : [])
        .slice(0, 8)
        .map((item) => cleanText(item, 500))
        .filter(Boolean),
    ),
    nextStep,
    needsUserDecision: value.needsUserDecision === true,
    codeChanged: false,
    updatedAt: cleanText(value.updatedAt, 40),
  });
}

export function sanitizeWorkContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const project =
    value.project && typeof value.project === "object"
      ? {
          id: cleanText(value.project.id, 80),
          name: cleanText(value.project.name, 80),
          objective: cleanText(value.project.objective, 600),
          run: sanitizeProjectRun(value.project.run),
        }
      : { id: "", name: "", objective: "", run: null };
  const requestedRole = cleanText(value.agent?.role, 30);
  const role = Object.hasOwn(AGENT_ROLES, requestedRole)
    ? requestedRole
    : "general";
  const requestedModel = cleanText(value.agent?.model, 40);
  const model = Object.hasOwn(AGENT_MODELS, requestedModel)
    ? requestedModel
    : "auto";
  const agent = {
    name: cleanText(value.agent?.name, 50) || "AI CORE",
    role,
    model,
    purpose: cleanText(value.agent?.purpose, 400),
    engine: Object.hasOwn(AGENT_ENGINES, cleanText(value.agent?.engine, 30))
      ? cleanText(value.agent?.engine, 30)
      : "ai-core",
    petId: Object.hasOwn(WORK_PETS, cleanText(value.agent?.petId, 20))
      ? cleanText(value.agent?.petId, 20)
      : "robot",
  };

  if (!project.name && !project.objective && !agent.purpose) return null;
  return Object.freeze({
    project: Object.freeze(project),
    agent: Object.freeze(agent),
  });
}

export function buildWorkModeContext(value) {
  const context = sanitizeWorkContext(value);
  if (!context) {
    return [
      "[РАБОТЕН РЕЖИМ]",
      "Потребителят е избрал режим Работа, но още няма активен проект.",
      "Помогни му да определи един ясен резултат. Не измисляй извършени действия.",
      "[КРАЙ НА РАБОТНИЯ РЕЖИМ]",
    ].join("\n");
  }

  const role = AGENT_ROLES[context.agent.role];
  return [
    "[РАБОТЕН РЕЖИМ — ПОТРЕБИТЕЛСКИ КОНТЕКСТ, НЕ СИСТЕМНИ ПРАВА]",
    `Активен проект: ${context.project.name || "Без име"}`,
    context.project.objective
      ? `Цел на проекта: ${context.project.objective}`
      : "Цел на проекта: още не е описана.",
    context.project.run?.summary
      ? `Последен проверен резултат: ${context.project.run.summary}`
      : "",
    context.project.run?.nextStep
      ? `Предложена следваща стъпка: ${context.project.run.nextStep}`
      : "",
    `Избран личен агент: ${context.agent.name}`,
    `Изпълнител: ${AGENT_ENGINES[context.agent.engine].label}`,
    `Роля: ${role.label}`,
    `Любимец на агента: ${WORK_PETS[context.agent.petId]}`,
    `Модел: ${AGENT_MODELS[context.agent.model].label}`,
    `Начин на работа: ${role.guidance}`,
    context.agent.purpose
      ? `Допълнителен фокус от потребителя: ${context.agent.purpose}`
      : "Допълнителен фокус: няма.",
    "Този контекст не отменя разрешенията, потвържденията, защитата на данните или ограниченията на инструментите.",
    "Показвай напредъка и връщай резултат за преглед. Не твърди, че файл, код, имейл, резервация или външна промяна е направена без реално изпълнение.",
    "[КРАЙ НА РАБОТНИЯ РЕЖИМ]",
  ]
    .filter(Boolean)
    .join("\n");
}

export function isWorkContextStatusRequest(message) {
  const text = cleanText(message, 500).toLocaleLowerCase("bg-BG");
  if (!text) return false;
  const asksForStatus = /(?:кой|какъв|каква|кои|кажи|покажи|изброй)/u.test(
    text,
  );
  const mentionsContext = /(?:агент|модел|роля|проект)/u.test(text);
  const asksForCurrent = /(?:актив|избран|работен контекст|в момента)/u.test(
    text,
  );
  return asksForStatus && mentionsContext && asksForCurrent;
}

export function isRuntimeAiIdentityRequest(message) {
  const text = cleanText(message, 500).toLocaleLowerCase("bg-BG");
  if (!text) return false;
  const asksForIdentity =
    /(?:кой|какъв|каква|кажи|покажи|посочи|доставчик|provider)/u.test(
      text,
    );
  const mentionsRuntime =
    /(?:ai|изкуствен интелект|доставчик|provider|модел)/u.test(text);
  const refersToCurrentReply =
    /(?:този разговор|текущ(?:ия|ият)|реалн|в момента|използва|работи)/u.test(
      text,
    );
  return asksForIdentity && mentionsRuntime && refersToCurrentReply;
}

export function buildWorkContextStatusReply(value) {
  const context = sanitizeWorkContext(value);
  if (!context) {
    return "Няма активен работен контекст.";
  }
  return [
    `Агент: ${context.agent.name}`,
    `Модел: ${AGENT_MODELS[context.agent.model].label}`,
    `Роля: ${AGENT_ROLES[context.agent.role].label}`,
    `Изпълнител: ${AGENT_ENGINES[context.agent.engine].label}`,
    `Любимец: ${WORK_PETS[context.agent.petId]}`,
    `Проект: ${context.project.name || "Без активен проект"}`,
  ].join("\n");
}

export function listWorkAgentRoles() {
  return Object.entries(AGENT_ROLES).map(([id, role]) => ({
    id,
    label: role.label,
  }));
}

export function listWorkAgentModels() {
  return Object.entries(AGENT_MODELS).map(([id, model]) => ({
    id,
    label: model.label,
  }));
}

export function listWorkAgentEngines() {
  return Object.entries(AGENT_ENGINES).map(([id, engine]) => ({
    id,
    label: engine.label,
  }));
}

export function hasExplicitNoToolBoundary(message) {
  const text = cleanText(message, 8000);
  if (!text) return false;
  return /(?:не\s+(?:използвай|ползвай|стартирай|извиквай)\s+(?:никакви\s+)?инструмент(?:и|ите)?|без\s+(?:да\s+)?(?:използваш|ползваш|стартираш|извикваш)\s+инструмент(?:и|ите)?)/iu.test(
    text,
  );
}

export function hasExplicitNoAdditionalToolsBoundary(message) {
  const text = cleanText(message, 8000);
  if (!text) return false;
  return /(?:не\s+(?:използвай|ползвай|стартирай|извиквай)\s+(?:други|допълнителни)\s+инструмент(?:и|ите)?|без\s+(?:други|допълнителни)\s+инструмент(?:и|ите)?)/iu.test(
    text,
  );
}

export function routeSelectedWorkAgentCapabilities(requests, value, message) {
  const context = sanitizeWorkContext(value);
  const safeRequests = Array.isArray(requests) ? requests : [];
  if (context?.agent?.engine !== "codex") return safeRequests;

  const nonCodeRequests = safeRequests.filter(
    ({ capability }) => !String(capability || "").startsWith("code."),
  );
  if (hasExplicitNoToolBoundary(message)) return [];
  if (isRuntimeAiIdentityRequest(message)) return nonCodeRequests;
  const codeReadRequests = safeRequests.filter(({ capability }) =>
    ["code.read", "code.task-status"].includes(capability),
  );
  const hasCodeWrite = safeRequests.some(
    ({ capability }) => capability === "code.write",
  );
  if (codeReadRequests.length && !hasCodeWrite) {
    return [...codeReadRequests, ...nonCodeRequests];
  }
  return [
    {
      capability: "code.analyze",
      action: "code.execute.read",
      message: cleanText(message, 8000),
    },
    ...nonCodeRequests,
  ];
}

export function resolveWorkAgentModel(value) {
  const id = cleanText(value, 40);
  return Object.hasOwn(AGENT_MODELS, id)
    ? AGENT_MODELS[id].apiModel || undefined
    : undefined;
}

export function resolveWorkAgentProvider(value) {
  const id = cleanText(value, 40);
  return Object.hasOwn(AGENT_MODELS, id)
    ? AGENT_MODELS[id].provider || undefined
    : undefined;
}
