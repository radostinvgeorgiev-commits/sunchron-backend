import { createHash } from "node:crypto";

import { listTools, registerCoreTools } from "../tools/toolRegistry.js";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";
import { filterCapabilityRequestsForIdentity } from "./memberCapabilityPolicy.js";
import { logSafeError } from "../utils/safeLogging.js";

// „Разкачи“ and „Свържи“ on each card in „Инструменти“ (RADKO 28.11 13:50 and
// 14:11): every person turns a tool off or on for their own avatar. A tool
// that is off is not used for that person by the chat, by an AI connected
// over MCP or by „Питай моя аватар“; nothing is deleted, and „Свържи“ turns it
// on again. The connections themselves (Google, GitHub, ChatGPT) keep their
// own „Разкачи“ on the cards at the top of „Инструменти“.

export const TOOL_SWITCH_COLLECTION = "novarium-tool-switches-v1";

// The avatar's memory holds its conversations too, so it is not a tool to
// unplug: it has its own settings in „Памет“.
const ALWAYS_ON = new Set(["google-firestore-memory"]);

export class ToolSwitchError extends Error {
  constructor(message, status = 503, code = "TOOL_SWITCH_UNAVAILABLE") {
    super(message);
    this.name = "ToolSwitchError";
    this.status = status;
    this.code = code;
  }
}

export function toolSwitchDocumentId(ownerId) {
  const owner = String(ownerId || "").trim();
  if (!owner) throw new ToolSwitchError("Липсва профил.", 401, "TOOL_SWITCH_OWNER_REQUIRED");
  return createHash("sha256").update("novarium-tool-switches-v1\0").update(owner).digest("hex");
}

function registeredTools() {
  registerCoreTools();
  return listTools();
}

// The tools this person may turn on or off: the ones their account can use
// at all (a member: their own Google, search, video, maps and „Моите задачи“),
// without the memory.
export function switchableTools(identity) {
  return registeredTools().filter(
    (tool) =>
      !ALWAYS_ON.has(tool.id) &&
      filterCapabilityRequestsForIdentity(
        tool.capabilities.map((capability) => ({ capability })),
        identity,
        { ownGoogle: true },
      ).length > 0,
  );
}

// The capabilities no tool can do while these tools are off: each one whose
// every tool is off.
export function capabilitiesOfTools(toolIds) {
  const off = new Set(toolIds);
  const capabilities = new Set();
  const tools = registeredTools();
  for (const tool of tools) {
    if (!off.has(tool.id)) continue;
    for (const capability of tool.capabilities) {
      if (tools.every((other) => !other.capabilities.includes(capability) || off.has(other.id))) {
        capabilities.add(capability);
      }
    }
  }
  return capabilities;
}

// The tool behind each tool an AI calls over MCP. Names that are not here
// (memory, the avatar's profile, the site's own checks) are not switched.
const MCP_TOOL_IDS = Object.freeze({
  send_message: "synchron-agent-chat",
  read_reply: "synchron-agent-chat",
  list_threads: "synchron-agent-chat",
  read_history: "synchron-agent-chat",
  continue_session: "synchron-agent-chat",
  talk_to_novarium: "synchron-agent-chat",
  list_synchron_conversations: "synchron-agent-chat",
  get_synchron_conversation: "synchron-agent-chat",
  list_available_capabilities: "synchron-integrations-status",
  list_action_history: "synchron-integrations-status",
  list_recent_errors: "synchron-integrations-status",
  get_system_configuration: "synchron-system-inspector",
  get_github_overview: "github-read",
  get_github_file: "github-read",
  prepare_github_change: "github-confirmed-write",
  confirm_github_change: "github-confirmed-write",
  prepare_github_merged_branch_cleanup: "github-confirmed-write",
  confirm_github_merged_branch_cleanup: "github-confirmed-write",
  list_google_drive_files: "google-drive-read",
  list_google_calendar_events: "google-calendar-read",
  suggest_calendar_slots: "google-calendar-read",
  prepare_calendar_event: "google-calendar-write",
  confirm_calendar_event: "google-calendar-write",
  search_gmail: "gmail-read",
  create_gmail_draft: "gmail-read",
  prepare_gmail_send: "gmail-read",
  prepare_gmail_delete: "gmail-read",
  search_google_contacts: "google-contacts",
  prepare_google_contact: "google-contacts",
  publish_video_to_youtube: "youtube-channel",
  list_tasks: "synchron-tasks",
  create_task_draft: "synchron-tasks",
  add_task_note: "synchron-tasks",
  link_task_to_project: "synchron-tasks",
  prepare_task_status_change: "synchron-tasks",
  confirm_task_status_change: "synchron-tasks",
  list_projects: "synchron-tasks",
  get_google_cloud_runtime_status: "google-cloud-read",
  get_google_cloud_project_diagnostics: "google-cloud-diagnostics",
  prepare_google_cloud_action: "google-cloud-write",
  confirm_google_cloud_action: "google-cloud-write",
});

export function toolOfMcpName(name) {
  return Object.hasOwn(MCP_TOOL_IDS, name) ? MCP_TOOL_IDS[name] : null;
}

function cleanOff(value) {
  const known = new Set(registeredTools().map((tool) => tool.id));
  return [...new Set(Array.isArray(value) ? value : [])].filter(
    (id) => typeof id === "string" && known.has(id) && !ALWAYS_ON.has(id),
  );
}

export function createToolSwitchService({ store, env = process.env, now = () => Date.now() } = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  // The tool ids this person turned off. Read on every use, so a press on
  // one server is seen at once on every other.
  async function toolsOff(ownerId) {
    const id = toolSwitchDocumentId(ownerId);
    let row;
    try {
      row = await db().get(TOOL_SWITCH_COLLECTION, id);
    } catch (error) {
      if ((error?.statusCode || error?.status) === 404) return [];
      throw new ToolSwitchError("Превключвателите на инструментите не можаха да се прочетат.");
    }
    return cleanOff(row?.data?.off);
  }

  // The capabilities to leave out for this person. When the switches cannot
  // be read, every tool that can be switched stays out for this request:
  // a tool the person turned off is never used by mistake.
  async function capabilitiesOff(ownerId) {
    try {
      return capabilitiesOfTools(await toolsOff(ownerId));
    } catch (error) {
      logSafeError("[Tools] switches unreadable; tools left out for this request", error);
      return capabilitiesOfTools(registeredTools().map((tool) => tool.id).filter((id) => !ALWAYS_ON.has(id)));
    }
  }

  async function isOff(ownerId, toolId) {
    if (!toolId || ALWAYS_ON.has(toolId)) return false;
    try {
      return (await toolsOff(ownerId)).includes(toolId);
    } catch (error) {
      logSafeError("[Tools] switches unreadable; tool refused for this call", error);
      return true;
    }
  }

  // The switches this person sees in „Инструменти“.
  async function list(ownerId, identity) {
    const off = new Set(await toolsOff(ownerId));
    return {
      tools: switchableTools(identity).map((tool) => ({ id: tool.id, on: !off.has(tool.id) })),
    };
  }

  async function set(ownerId, identity, toolId, on) {
    if (typeof on !== "boolean") {
      throw new ToolSwitchError("Кажи дали инструментът да е свързан.", 400, "TOOL_SWITCH_INVALID");
    }
    if (!switchableTools(identity).some((tool) => tool.id === toolId)) {
      throw new ToolSwitchError("Няма такъв инструмент.", 404, "TOOL_SWITCH_NOT_FOUND");
    }
    const off = new Set(await toolsOff(ownerId));
    if (on) off.delete(toolId);
    else off.add(toolId);
    try {
      await db().set(TOOL_SWITCH_COLLECTION, toolSwitchDocumentId(ownerId), {
        off: cleanOff([...off]),
        updatedAt: now(),
      });
    } catch {
      throw new ToolSwitchError("Промяната не беше записана. Опитай пак.");
    }
    return list(ownerId, identity);
  }

  return Object.freeze({ toolsOff, capabilitiesOff, isOff, list, set });
}

let defaultService = null;
export function getToolSwitchService() {
  return (defaultService ||= createToolSwitchService());
}

export function setToolSwitchServiceForTests(service) {
  defaultService = service || null;
}
