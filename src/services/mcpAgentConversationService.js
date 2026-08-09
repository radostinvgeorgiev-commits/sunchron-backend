import { randomUUID } from "node:crypto";

import { buildAvatarMessages } from "../routes/chat.js";
import {
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
} from "./memoryService.js";
import { requestAiText } from "./aiCoreService.js";
import { loadWorkspaceState } from "./workspaceStateService.js";
import {
  resolveWorkAgentModel,
  resolveWorkAgentProvider,
} from "./workModeService.js";

const MAX_MESSAGE_LENGTH = 6_000;
const MAX_SESSION_QUESTIONS = 10;
const SAFE_ID_PATTERN = /^[a-z0-9:_-]+$/iu;
const BRIDGE_BOUNDARY = [
  "[MCP МОСТ — САМО РАЗГОВОР]",
  "Този разговор не може да изпълнява инструменти или външни действия.",
  "Не променяй код, файлове, GitHub, календар, поща, памет, настройки или инфраструктура.",
  "Не твърди, че действие е извършено. Върни само текстов отговор за преглед.",
  "[КРАЙ НА MCP ГРАНИЦАТА]",
].join("\n");

export class McpAgentConversationError extends Error {
  constructor(message, code = "MCP_AGENT_CONVERSATION_ERROR", status = 400) {
    super(message);
    this.name = "McpAgentConversationError";
    this.code = code;
    this.status = status;
  }
}

function cleanRequiredText(value, maxLength, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpAgentConversationError(`Липсва ${label}.`, -32602);
  }
  const clean = value.trim();
  if (clean.length > maxLength) {
    throw new McpAgentConversationError(`${label} е прекалено дълго.`, -32602);
  }
  return clean;
}

function cleanOptionalId(value, maxLength, label) {
  if (value === undefined || value === null || value === "") return "";
  const clean = cleanRequiredText(value, maxLength, label);
  if (!SAFE_ID_PATTERN.test(clean)) {
    throw new McpAgentConversationError(`Невалидно ${label}.`, -32602);
  }
  return clean;
}

function resolveSelection(state, projectId, agentId) {
  const selectedProjectId = projectId || state.activeProjectId;
  const selectedAgentId = agentId || state.activeAgentId;
  const project = state.projects.find((item) => item.id === selectedProjectId);
  const agent = state.agents.find((item) => item.id === selectedAgentId);

  if (!project) {
    throw new McpAgentConversationError(
      "Проектът не принадлежи на този профил.",
      -32602,
    );
  }
  if (!agent) {
    throw new McpAgentConversationError(
      "Агентът не принадлежи на този профил.",
      -32602,
    );
  }
  if (agent.engine !== "ai-core") {
    throw new McpAgentConversationError(
      "Този MCP инструмент разговаря само с AI CORE. Codex остава отделен изолиран изпълнител.",
      -32602,
    );
  }
  return { project, agent };
}

function bridgeIdentity(identity) {
  const role = identity?.role === "owner" ? "owner" : "member";
  return {
    role,
    displayName:
      typeof identity?.displayName === "string" && identity.displayName.trim()
        ? identity.displayName.trim()
        : role === "owner"
          ? "Радко"
          : "Потребител",
  };
}

export async function sendMcpAgentMessage(
  { ownerId, message, sessionId, projectId, agentId, identity },
  {
    loadWorkspace = loadWorkspaceState,
    listMemories = listProfileMemories,
    listMessages = listConversationMessages,
    askAi = requestAiText,
    saveTurn = saveConversationTurn,
    createSessionId = () => `mcp-${randomUUID()}`,
  } = {},
) {
  const cleanOwnerId = cleanRequiredText(ownerId, 200, "проверен профил");
  const cleanMessage = cleanRequiredText(
    message,
    MAX_MESSAGE_LENGTH,
    "съобщение",
  );
  const cleanSessionId =
    cleanOptionalId(sessionId, 160, "sessionId") || createSessionId();
  const cleanProjectId = cleanOptionalId(projectId, 80, "projectId");
  const cleanAgentId = cleanOptionalId(agentId, 80, "agentId");

  const workspace = await loadWorkspace(cleanOwnerId);
  const { project, agent } = resolveSelection(
    workspace.state,
    cleanProjectId,
    cleanAgentId,
  );
  const [memories, history] = await Promise.all([
    listMemories({ ownerId: cleanOwnerId }),
    listMessages(cleanSessionId, undefined, cleanOwnerId),
  ]);
  const previousQuestions = history.filter(
    (item) => item?.role === "user",
  ).length;
  if (previousQuestions >= MAX_SESSION_QUESTIONS) {
    throw new McpAgentConversationError(
      "Тази MCP сесия достигна лимита от 10 въпроса. Започни нова нишка без sessionId.",
      -32602,
    );
  }
  const workContext = {
    project,
    agent,
  };
  const input = buildAvatarMessages(
    memories,
    history,
    cleanMessage,
    bridgeIdentity(identity),
    { mode: "work", workContext },
  ).map((item, index) =>
    index === 0
      ? { ...item, content: `${item.content}\n\n${BRIDGE_BOUNDARY}` }
      : item,
  );
  const response = await askAi({
    provider: resolveWorkAgentProvider(agent.model),
    input,
    model: resolveWorkAgentModel(agent.model),
    reasoningEffort: "low",
    verbosity: "medium",
  });
  await saveTurn(cleanSessionId, cleanMessage, response, cleanOwnerId);

  return Object.freeze({
    sessionId: cleanSessionId,
    response,
    project: Object.freeze({ id: project.id, name: project.name }),
    agent: Object.freeze({
      id: agent.id,
      name: agent.name,
      role: agent.role,
    }),
    conversationPersisted: true,
    externalActionsExecuted: false,
    codeChanged: false,
    turnNumber: previousQuestions + 1,
    turnsRemaining: MAX_SESSION_QUESTIONS - previousQuestions - 1,
  });
}

export const MCP_AGENT_SESSION_QUESTION_LIMIT = MAX_SESSION_QUESTIONS;
