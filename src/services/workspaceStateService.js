import { createHash } from "node:crypto";

import { getOpenSearchClient } from "../config/opensearch.js";

const DEFAULT_INDEX = "synchron-workspaces-v1";
const VALID_MODES = new Set(["chat", "work"]);
const VALID_STATUSES = new Set(["ready", "running", "needs-input", "blocked"]);
const VALID_ROLES = new Set(["general", "researcher", "organizer", "builder"]);
const VALID_MODELS = new Set([
  "auto",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const VALID_PETS = new Set(["robot", "drop", "spark", "owl", "rock", "cat"]);

export class WorkspaceStateError extends Error {
  constructor(message, status = 503, code = "WORKSPACE_STATE_UNAVAILABLE") {
    super(message);
    this.name = "WorkspaceStateError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanId(value, fallback) {
  const id = cleanText(value, 80).replace(/[^a-z0-9:_-]/giu, "-");
  return id || fallback;
}

function defaultWorkspaceState(now = new Date().toISOString()) {
  return {
    version: 2,
    mode: "chat",
    activeProjectId: "starter-project",
    activeAgentId: "synchron-builder",
    petId: "robot",
    petState: "ready",
    projects: [
      {
        id: "starter-project",
        name: "Първи проект",
        objective: "",
        status: "ready",
        updatedAt: now,
      },
    ],
    agents: [
      {
        id: "synchron-builder",
        name: "AI CORE",
        role: "builder",
        model: "auto",
        purpose: "Подготвя реален резултат и показва какво е проверено.",
      },
    ],
    activities: [],
  };
}

export function normalizeWorkspaceState(value, { now } = {}) {
  const timestamp = now || new Date().toISOString();
  const fallback = defaultWorkspaceState(timestamp);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const projects = Array.isArray(value.projects)
    ? value.projects.slice(0, 20).map((project, index) => ({
        id: cleanId(project?.id, `project-${index + 1}`),
        name: cleanText(project?.name, 80) || "Проект",
        objective: cleanText(project?.objective, 600),
        status: VALID_STATUSES.has(project?.status) ? project.status : "ready",
        updatedAt: cleanText(project?.updatedAt, 40) || timestamp,
      }))
    : fallback.projects;
  const agents = Array.isArray(value.agents)
    ? value.agents.slice(0, 12).map((agent, index) => ({
        id: cleanId(agent?.id, `agent-${index + 1}`),
        name: cleanText(agent?.name, 50) || "Личен агент",
        role: VALID_ROLES.has(agent?.role) ? agent.role : "general",
        model: VALID_MODELS.has(agent?.model) ? agent.model : "auto",
        purpose: cleanText(agent?.purpose, 400),
      }))
    : fallback.agents;
  const activities = Array.isArray(value.activities)
    ? value.activities.slice(0, 40).map((activity, index) => ({
        id: cleanId(activity?.id || activity?.taskId, `activity-${index + 1}`),
        projectId: cleanId(activity?.projectId, ""),
        status: VALID_STATUSES.has(activity?.status)
          ? activity.status
          : "ready",
        message: cleanText(activity?.message, 240),
        verified: activity?.verified === true,
        updatedAt: cleanText(activity?.updatedAt, 40) || timestamp,
      }))
    : [];

  if (!projects.length) projects.push(...fallback.projects);
  if (!agents.length) agents.push(...fallback.agents);

  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? value.activeProjectId
    : projects[0].id;
  const activeAgentId = agents.some((agent) => agent.id === value.activeAgentId)
    ? value.activeAgentId
    : agents[0].id;

  return {
    version: 2,
    mode: VALID_MODES.has(value.mode) ? value.mode : "chat",
    activeProjectId,
    activeAgentId,
    petId: VALID_PETS.has(value.petId) ? value.petId : "robot",
    petState: VALID_STATUSES.has(value.petState) ? value.petState : "ready",
    projects,
    agents,
    activities,
  };
}

export function workspaceDocumentId(ownerId) {
  const owner = cleanText(ownerId, 200);
  if (!owner) {
    throw new WorkspaceStateError(
      "Липсва проверен потребител за работната област.",
      401,
      "WORKSPACE_OWNER_REQUIRED",
    );
  }
  return createHash("sha256")
    .update("synchron-workspace-state-v1\0")
    .update(owner)
    .digest("hex");
}

function indexName(env = process.env) {
  return cleanText(env.WORKSPACE_STATE_INDEX, 120) || DEFAULT_INDEX;
}

function requireClient(client = getOpenSearchClient()) {
  if (!client) {
    throw new WorkspaceStateError("Работната област временно не е достъпна.");
  }
  return client;
}

function statusCode(error) {
  return error?.statusCode || error?.meta?.statusCode || error?.status;
}

export async function loadWorkspaceState(
  ownerId,
  { client, env = process.env } = {},
) {
  const documentId = workspaceDocumentId(ownerId);
  try {
    const response = await requireClient(client).get({
      index: indexName(env),
      id: documentId,
    });
    return {
      state: normalizeWorkspaceState(response.body?._source?.state),
      persisted: true,
      updatedAt: response.body?._source?.updatedAt || null,
    };
  } catch (error) {
    if (statusCode(error) === 404) {
      return {
        state: normalizeWorkspaceState(null),
        persisted: false,
        updatedAt: null,
      };
    }
    if (error instanceof WorkspaceStateError) throw error;
    throw new WorkspaceStateError(
      "Работната област не можа да бъде заредена.",
      503,
      "WORKSPACE_LOAD_FAILED",
    );
  }
}

export async function saveWorkspaceState(
  ownerId,
  value,
  { client, env = process.env, now } = {},
) {
  const documentId = workspaceDocumentId(ownerId);
  const updatedAt = now || new Date().toISOString();
  const state = normalizeWorkspaceState(value, { now: updatedAt });
  try {
    await requireClient(client).index({
      index: indexName(env),
      id: documentId,
      body: {
        schemaVersion: 1,
        ownerHash: documentId,
        state,
        updatedAt,
      },
      refresh: false,
    });
  } catch (error) {
    if (error instanceof WorkspaceStateError) throw error;
    throw new WorkspaceStateError(
      "Работната област не можа да бъде запазена.",
      503,
      "WORKSPACE_SAVE_FAILED",
    );
  }
  return { state, persisted: true, updatedAt };
}
