import { randomUUID } from "node:crypto";

import {
  buildAvatarMessages,
  buildCapabilityReplies,
  detectCapabilityRequests,
} from "../routes/chat.js";
import {
  listConversationMessages,
  listProfileMemories,
  saveConversationTurn,
} from "./memoryService.js";
import { requestAiText } from "./aiCoreService.js";
import { loadWorkspaceState } from "./workspaceStateService.js";
import {
  planCapabilities,
  shouldUseAgentPlanner,
} from "./agentPlannerService.js";
import {
  canPlanCapabilities,
  filterCapabilityRequestsForIdentity,
} from "./memberCapabilityPolicy.js";
import { orchestrateTask } from "./taskOrchestratorService.js";
import { executeCapability } from "../tools/capabilityEngine.js";
import {
  hasExplicitNoAdditionalToolsBoundary,
  hasExplicitNoToolBoundary,
  routeSelectedWorkAgentCapabilities,
  resolveWorkAgentModel,
  resolveWorkAgentProvider,
  sanitizeWorkContext,
} from "./workModeService.js";
import { getLatestGoogleSessionId } from "./googleDriveService.js";
import { getLatestAuthorizedGitHubSession } from "./githubOAuthService.js";
import { recordAuditEvent } from "./permissionService.js";

const MAX_MESSAGE_LENGTH = 6_000;
const MAX_SESSION_QUESTIONS = 10;
const SAFE_ID_PATTERN = /^[a-z0-9:_-]+$/iu;
const BRIDGE_BOUNDARY = [
  "[MCP МОСТ — ПРОВЕРЕН ИНСТРУМЕНТАЛЕН РЕЖИМ]",
  "Заявките за инструменти се изпълняват само през проверения capability engine на AI CORE.",
  "Read-only проверките могат да се изпълнят и да върнат реален резултат.",
  "Записите, изпращанията и инфраструктурните промени никога не се изпълняват директно: подготви точна операция и изчакай отделно owner потвърждение.",
  "Не изпълнявай shell команди, произволни URL адреси или действия извън регистрираните инструменти; не показвай secrets.",
  "Не твърди, че промяна е извършена без потвърден резултат от инструмента.",
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
    runTask = orchestrateTask,
    execute = executeCapability,
    plan = planCapabilities,
    shouldPlan = shouldUseAgentPlanner,
    getGoogleSession = getLatestGoogleSessionId,
    getGitHubSession = getLatestAuthorizedGitHubSession,
    auditTask = (event) =>
      recordAuditEvent({ actor: "ai-core-avatar", ...event }),
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
  const sanitizedWorkContext = sanitizeWorkContext(workContext) || workContext;
  const safeIdentity = identity || { role: "member", displayName: "Потребител" };
  const noToolBoundary =
    hasExplicitNoToolBoundary(cleanMessage) ||
    hasExplicitNoAdditionalToolsBoundary(cleanMessage);
  const fallbackRequests = noToolBoundary
    ? []
    : filterCapabilityRequestsForIdentity(
        detectCapabilityRequests(cleanMessage),
        safeIdentity,
      );
  const planningAllowed =
    !noToolBoundary &&
    canPlanCapabilities(safeIdentity) &&
    Boolean(process.env.OPENAI_API_KEY);

  let googleSessionId = null;
  let githubSession = null;
  if (
    /(?:google|drive|драйв|gmail|джимейл|календар|calendar|контакт)/iu.test(
      cleanMessage,
    )
  ) {
    try {
      googleSessionId = await getGoogleSession();
    } catch {
      googleSessionId = null;
    }
  }
  if (
    safeIdentity?.role === "owner" &&
    /(?:github|ги[тд][\s-]*хъб|репозитор|хранилищ|код|branch|клон|commit|комит|pull\s*request|\bpr\b)/iu.test(
      cleanMessage,
    )
  ) {
    try {
      githubSession = await getGitHubSession();
    } catch {
      githubSession = null;
    }
  }

  const taskExecution = await runTask({
    message: cleanMessage,
    fallbackRequests,
    planningAllowed,
    plannerContext: { openAiApiKey: process.env.OPENAI_API_KEY },
    planFn: plan,
    shouldPlanFn: shouldPlan,
    normalizeRequests: (requests) =>
      filterCapabilityRequestsForIdentity(requests, safeIdentity),
    routeRequests: (requests) =>
      routeSelectedWorkAgentCapabilities(
        requests,
        sanitizedWorkContext,
        cleanMessage,
      ),
    executeFn: execute,
    executionContext: {
      googleSessionId,
      githubSessionId: githubSession?.id || null,
      githubSession,
      ownerId: cleanOwnerId,
      // MCP confirmations are scoped to the verified owner, while the
      // conversation history remains isolated by cleanSessionId.
      sessionId: cleanOwnerId,
      workContext: sanitizedWorkContext,
      identity: safeIdentity,
      prepareConfirmation: true,
    },
    audit: auditTask,
  });
  const capabilityResults = taskExecution?.results || [];
  const capabilityReplies = buildCapabilityReplies(capabilityResults);
  const capabilityOutput = capabilityReplies.join("\n\n").trim();
  const input = buildAvatarMessages(
    memories,
    history,
    cleanMessage,
    bridgeIdentity(safeIdentity),
    { mode: "work", workContext: sanitizedWorkContext },
  ).map((item, index) =>
    index === 0
      ? { ...item, content: `${item.content}\n\n${BRIDGE_BOUNDARY}` }
      : item,
  );
  const response = capabilityOutput
    ? capabilityOutput
    : await askAi({
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
    capabilities: Object.freeze(
      (taskExecution?.requests || []).map((request) => request.capability),
    ),
    task: taskExecution?.task || null,
    plannerUsed: taskExecution?.plannerUsed === true,
    plannerErrorCode: taskExecution?.plannerErrorCode || null,
    externalActionsExecuted: false,
    codeChanged: false,
    turnNumber: previousQuestions + 1,
    turnsRemaining: MAX_SESSION_QUESTIONS - previousQuestions - 1,
  });
}

export const MCP_AGENT_SESSION_QUESTION_LIMIT = MAX_SESSION_QUESTIONS;
