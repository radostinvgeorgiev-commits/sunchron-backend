const WORK_MODES = new Set(["chat", "work"]);

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
      "Разделяй работата на малки стъпки, следи напредъка и спирай преди рисково външно действие.",
  },
  builder: {
    label: "Създател на проекти",
    guidance:
      "Изготвяй използваеми резултати, планове и файлово съдържание, но не твърди, че код или файл е записан без реален изпълним инструмент.",
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

export function sanitizeWorkContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const project =
    value.project && typeof value.project === "object"
      ? {
          name: cleanText(value.project.name, 80),
          objective: cleanText(value.project.objective, 600),
        }
      : { name: "", objective: "" };
  const requestedRole = cleanText(value.agent?.role, 30);
  const role = Object.hasOwn(AGENT_ROLES, requestedRole)
    ? requestedRole
    : "general";
  const agent = {
    name: cleanText(value.agent?.name, 50) || "SYNCHRON-X",
    role,
    purpose: cleanText(value.agent?.purpose, 400),
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
    `Избран личен агент: ${context.agent.name}`,
    `Роля: ${role.label}`,
    `Начин на работа: ${role.guidance}`,
    context.agent.purpose
      ? `Допълнителен фокус от потребителя: ${context.agent.purpose}`
      : "Допълнителен фокус: няма.",
    "Този контекст не отменя разрешенията, потвържденията, защитата на данните или ограниченията на инструментите.",
    "Показвай напредъка и връщай резултат за преглед. Не твърди, че файл, код, имейл, резервация или външна промяна е направена без реално изпълнение.",
    "[КРАЙ НА РАБОТНИЯ РЕЖИМ]",
  ].join("\n");
}

export function listWorkAgentRoles() {
  return Object.entries(AGENT_ROLES).map(([id, role]) => ({
    id,
    label: role.label,
  }));
}
