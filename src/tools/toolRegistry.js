const HEALTH_STATUSES = new Set(["healthy", "degraded", "unavailable"]);

function freezeTool(tool) {
  return Object.freeze({
    ...tool,
    capabilities: Object.freeze([...tool.capabilities]),
    permissions: Object.freeze([...tool.permissions]),
    capabilityPermissions: Object.freeze({
      ...(tool.capabilityPermissions || {}),
    }),
  });
}

const tools = new Map();

export function registerTool(definition) {
  const requiredStrings = ["id", "provider", "name", "version", "category"];
  for (const field of requiredStrings) {
    if (typeof definition?.[field] !== "string" || !definition[field].trim()) {
      throw new TypeError(`Tool Registry: липсва валидно поле "${field}".`);
    }
  }
  if (
    !Array.isArray(definition.capabilities) ||
    !definition.capabilities.length
  ) {
    throw new TypeError(
      "Tool Registry: инструментът трябва да има способности.",
    );
  }
  if (!Array.isArray(definition.permissions)) {
    throw new TypeError("Tool Registry: permissions трябва да е списък.");
  }
  if (
    definition.capabilityPermissions !== undefined &&
    (definition.capabilityPermissions === null ||
      Array.isArray(definition.capabilityPermissions) ||
      typeof definition.capabilityPermissions !== "object")
  ) {
    throw new TypeError(
      "Tool Registry: capabilityPermissions трябва да е обект.",
    );
  }
  for (const capability of definition.capabilities) {
    const permission = definition.capabilityPermissions?.[capability];
    if (
      typeof permission !== "string" ||
      !definition.permissions.includes(permission)
    ) {
      throw new TypeError(
        `Tool Registry: липсва валидно разрешение за "${capability}".`,
      );
    }
  }
  if (typeof definition.enabled !== "boolean") {
    throw new TypeError("Tool Registry: enabled трябва да е boolean.");
  }
  if (typeof definition.requiresConfirmation !== "boolean") {
    throw new TypeError(
      "Tool Registry: requiresConfirmation трябва да е boolean.",
    );
  }
  if (!HEALTH_STATUSES.has(definition.healthStatus)) {
    throw new TypeError("Tool Registry: невалиден healthStatus.");
  }
  if (tools.has(definition.id)) {
    throw new Error(`Tool Registry: дублиран id "${definition.id}".`);
  }

  const tool = freezeTool(definition);
  tools.set(tool.id, tool);
  return tool;
}

export function getTool(id) {
  return tools.get(id) || null;
}

export function listTools() {
  return [...tools.values()];
}

export function findToolsByCapability(capability, options = {}) {
  const { enabledOnly = true, healthyOnly = true } = options;
  return listTools().filter(
    (tool) =>
      tool.capabilities.includes(capability) &&
      (!enabledOnly || tool.enabled) &&
      (!healthyOnly || tool.healthStatus === "healthy"),
  );
}

export function resetToolRegistryForTests() {
  tools.clear();
}

export function registerCoreTools() {
  [
    {
      id: "synchron-agent-chat",
      provider: "synchron",
      name: "AI CORE Conversation",
      version: "1.0.0",
      category: "chat",
      capabilities: [
        "chat.send_message",
        "chat.read_reply",
        "chat.list_threads",
        "chat.read_history",
        "chat.continue_session",
      ],
      permissions: ["agent.chat"],
      capabilityPermissions: {
        "chat.send_message": "agent.chat",
        "chat.read_reply": "agent.chat",
        "chat.list_threads": "agent.chat",
        "chat.read_history": "agent.chat",
        "chat.continue_session": "agent.chat",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "synchron-integrations-status",
      provider: "synchron",
      name: "AI CORE Status",
      version: "1.0.0",
      category: "system",
      capabilities: [
        "system.integrations.status",
        "system.tools.read",
        "system.audit.read",
        "system.errors.read",
      ],
      permissions: ["infrastructure.read"],
      capabilityPermissions: {
        "system.integrations.status": "infrastructure.read",
        "system.tools.read": "infrastructure.read",
        "system.audit.read": "infrastructure.read",
        "system.errors.read": "infrastructure.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "synchron-system-inspector",
      provider: "synchron",
      name: "Системен контрол",
      version: "1.0.0",
      category: "system",
      capabilities: ["system.configuration.read"],
      permissions: ["infrastructure.read"],
      capabilityPermissions: {
        "system.configuration.read": "infrastructure.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "github-read",
      provider: "github",
      name: "GitHub Read",
      version: "1.0.0",
      category: "code",
      capabilities: [
        "code.read",
        "code.search",
        "commit.read",
        "code.task-status",
        "issues.read",
        "pull-requests.read",
        "actions.read",
      ],
      permissions: ["github.read"],
      capabilityPermissions: {
        "code.read": "github.read",
        "code.search": "github.read",
        "commit.read": "github.read",
        "code.task-status": "github.read",
        "issues.read": "github.read",
        "pull-requests.read": "github.read",
        "actions.read": "github.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "github-write",
      provider: "github",
      name: "GitHub Write",
      version: "0.1.0",
      category: "code",
      capabilities: [
        "code.write",
        "code.branch",
        "code.pull-request",
        "issue.close",
      ],
      permissions: ["github.write"],
      capabilityPermissions: {
        "code.write": "github.write",
        "code.branch": "github.write",
        "code.pull-request": "github.write",
        "issue.close": "github.write",
      },
      enabled: true,
      requiresConfirmation: true,
      healthStatus: "unavailable",
    },
    {
      id: "github-confirmed-write",
      provider: "github",
      name: "GitHub Confirmed Write",
      version: "1.0.0",
      category: "code",
      capabilities: [
        "github.branch.create",
        "github.file.create",
        "github.file.update",
        "github.pull-request.create",
        "github.issue.close",
      ],
      permissions: ["github.write"],
      capabilityPermissions: {
        "github.branch.create": "github.write",
        "github.file.create": "github.write",
        "github.file.update": "github.write",
        "github.pull-request.create": "github.write",
        "github.issue.close": "github.write",
      },
      enabled: true,
      requiresConfirmation: true,
      healthStatus: "unavailable",
    },
    {
      id: "openai-codex",
      provider: "openai",
      name: "Codex",
      version: "1.0.0",
      category: "code",
      capabilities: ["code.analyze"],
      permissions: ["code.execute.read"],
      capabilityPermissions: {
        "code.analyze": "code.execute.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "google-drive-read",
      provider: "google",
      name: "Google Drive Read",
      version: "1.0.0",
      category: "files",
      capabilities: ["files.read", "files.search"],
      permissions: ["drive.read"],
      capabilityPermissions: {
        "files.read": "drive.read",
        "files.search": "drive.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "google-calendar-read",
      provider: "google",
      name: "Google Calendar Read",
      version: "1.0.0",
      category: "calendar",
      capabilities: ["calendar.read"],
      permissions: ["calendar.read"],
      capabilityPermissions: {
        "calendar.read": "calendar.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "google-calendar-write",
      provider: "google",
      name: "Google Calendar Write",
      version: "1.0.0",
      category: "calendar",
      capabilities: ["calendar.write"],
      permissions: ["calendar.write"],
      capabilityPermissions: {
        "calendar.write": "calendar.write",
      },
      enabled: true,
      requiresConfirmation: true,
      healthStatus: "unavailable",
    },
    {
      id: "gmail-read",
      provider: "google",
      name: "Gmail Read",
      version: "1.0.0",
      category: "mail",
      capabilities: [
        "mail.read",
        "mail.search",
        "mail.draft",
        "mail.send",
        "mail.delete",
      ],
      permissions: ["mail.read", "mail.draft", "mail.send", "mail.delete"],
      capabilityPermissions: {
        "mail.read": "mail.read",
        "mail.search": "mail.read",
        "mail.draft": "mail.draft",
        "mail.send": "mail.send",
        "mail.delete": "mail.delete",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "google-contacts",
      provider: "google",
      name: "Google Contacts",
      version: "1.0.0",
      category: "contacts",
      capabilities: ["contacts.read", "contacts.create", "contacts.update"],
      permissions: ["contacts.read", "contacts.write"],
      capabilityPermissions: {
        "contacts.read": "contacts.read",
        "contacts.create": "contacts.write",
        "contacts.update": "contacts.write",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "synchron-tasks",
      provider: "synchron",
      name: "SYNCHRON-X Tasks",
      version: "1.0.0",
      category: "tasks",
      capabilities: [
        "tasks.read",
        "tasks.draft",
        "tasks.note",
        "tasks.status",
        "tasks.link-project",
        "tasks.progress",
      ],
      permissions: ["tasks.read", "tasks.draft", "tasks.update"],
      capabilityPermissions: {
        "tasks.read": "tasks.read",
        "tasks.draft": "tasks.draft",
        "tasks.note": "tasks.draft",
        "tasks.status": "tasks.update",
        "tasks.link-project": "tasks.draft",
        "tasks.progress": "tasks.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "openai-web-search",
      provider: "openai",
      name: "OpenAI Web Search",
      version: "1.0.0",
      category: "search",
      capabilities: ["web.search"],
      permissions: ["web.read"],
      capabilityPermissions: {
        "web.search": "web.read",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
    {
      id: "firestore-memory",
      provider: "synchron",
      name: "Synchron Memory",
      version: "1.0.0",
      category: "memory",
      capabilities: [
        "memory.read",
        "memory.search",
        "memory.verify",
        "memory.save",
        "memory.update",
        "memory.delete",
      ],
      permissions: [
        "memory.read",
        "memory.test",
        "memory.write",
        "memory.delete",
      ],
      capabilityPermissions: {
        "memory.read": "memory.read",
        "memory.search": "memory.read",
        "memory.verify": "memory.test",
        "memory.save": "memory.write",
        "memory.update": "memory.write",
        "memory.delete": "memory.delete",
      },
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "unavailable",
    },
  ].forEach((definition) => {
    if (!tools.has(definition.id)) registerTool(definition);
  });

  return listTools();
}
