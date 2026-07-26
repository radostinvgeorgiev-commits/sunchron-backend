const HEALTH_STATUSES = new Set(["healthy", "degraded", "unavailable"]);

function freezeTool(tool) {
  return Object.freeze({
    ...tool,
    capabilities: Object.freeze([...tool.capabilities]),
    permissions: Object.freeze([...tool.permissions]),
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
  if (!Array.isArray(definition.capabilities) || !definition.capabilities.length) {
    throw new TypeError("Tool Registry: инструментът трябва да има способности.");
  }
  if (!Array.isArray(definition.permissions)) {
    throw new TypeError("Tool Registry: permissions трябва да е списък.");
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
  if (tools.size) return listTools();

  [
    {
      id: "github-read",
      provider: "github",
      name: "GitHub Read",
      version: "1.0.0",
      category: "code",
      capabilities: ["code.read", "code.search", "commit.read"],
      permissions: ["github.read"],
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "healthy",
    },
    {
      id: "google-drive-read",
      provider: "google",
      name: "Google Drive Read",
      version: "1.0.0",
      category: "files",
      capabilities: ["files.read", "files.search"],
      permissions: ["drive.read"],
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "healthy",
    },
    {
      id: "google-calendar-read",
      provider: "google",
      name: "Google Calendar Read",
      version: "1.0.0",
      category: "calendar",
      capabilities: ["calendar.read"],
      permissions: ["calendar.read"],
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "healthy",
    },
    {
      id: "gmail-read",
      provider: "google",
      name: "Gmail Read",
      version: "1.0.0",
      category: "mail",
      capabilities: ["mail.read", "mail.search"],
      permissions: ["mail.read"],
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "healthy",
    },
    {
      id: "openai-web-search",
      provider: "openai",
      name: "OpenAI Web Search",
      version: "1.0.0",
      category: "search",
      capabilities: ["web.search"],
      permissions: ["web.read"],
      enabled: true,
      requiresConfirmation: false,
      healthStatus: "healthy",
    },
    {
      id: "opensearch-memory",
      provider: "opensearch",
      name: "Synchron Memory",
      version: "1.0.0",
      category: "memory",
      capabilities: [
        "memory.read",
        "memory.search",
        "memory.save",
        "memory.update",
        "memory.delete",
      ],
      permissions: ["memory.read", "memory.write", "memory.delete"],
      enabled: true,
      requiresConfirmation: true,
      healthStatus: "healthy",
    },
  ].forEach(registerTool);

  return listTools();
}
