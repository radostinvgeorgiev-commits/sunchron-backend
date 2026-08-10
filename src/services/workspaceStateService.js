import { createHash } from "node:crypto";

import { getOpenSearchClient } from "../config/opensearch.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreWorkspaceStore } from "./firestoreWorkspaceStore.js";

const DEFAULT_INDEX = "synchron-workspaces-v1";
let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreWorkspaceStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}
const WORKSPACE_VERSION = 6;
const VALID_MODES = new Set(["chat", "work"]);
const VALID_STATUSES = new Set(["ready", "running", "needs-input", "blocked"]);
const VALID_ROLES = new Set([
  "general",
  "researcher",
  "organizer",
  "documents",
  "builder",
  "coder",
]);
const VALID_ENGINES = new Set(["ai-core", "codex"]);
const VALID_RUN_STATUSES = new Set([
  "complete",
  "ready_for_next_step",
  "blocked",
]);
const VALID_MODELS = new Set([
  "auto",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-2.5-flash",
  "grok-4.5",
]);
const LEGACY_MODEL_MIGRATIONS = new Map([["grok-3-mini", "grok-4.5"]]);
const VALID_PETS = new Set(["robot", "drop", "spark", "owl", "rock", "cat"]);
const VALID_MEMORY_MODES = new Set(["confirm", "disabled"]);

const DEFAULT_AGENTS = Object.freeze([
  Object.freeze({
    id: "synchron-builder",
    name: "Изпълни",
    role: "builder",
    model: "auto",
    purpose: "Подготвя реален резултат и показва какво е проверено.",
    engine: "ai-core",
    petId: "robot",
  }),
  Object.freeze({
    id: "research-agent",
    name: "Проучи",
    role: "researcher",
    model: "auto",
    purpose: "Проверява актуални източници и отделя фактите от изводите.",
    engine: "ai-core",
    petId: "owl",
  }),
  Object.freeze({
    id: "organizer-agent",
    name: "Организирай",
    role: "organizer",
    model: "auto",
    purpose: "Подрежда задачи и календар, като спира преди външни промени.",
    engine: "ai-core",
    petId: "rock",
  }),
  Object.freeze({
    id: "documents-agent",
    name: "Напиши",
    role: "documents",
    model: "auto",
    purpose: "Работи с разрешени файлове, документи и поща.",
    engine: "ai-core",
    petId: "cat",
  }),
  Object.freeze({
    id: "codex-agent",
    name: "Код",
    role: "coder",
    model: "gpt-5.6-terra",
    purpose: "Анализира кода в изолирана област без запис и без интернет.",
    engine: "codex",
    petId: "spark",
  }),
]);

function agentPetId(agent) {
  if (VALID_PETS.has(agent?.petId)) return agent.petId;
  return (
    DEFAULT_AGENTS.find((defaultAgent) => defaultAgent.id === agent?.id)
      ?.petId || "robot"
  );
}

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

function normalizeAgentModel(value) {
  const migrated = LEGACY_MODEL_MIGRATIONS.get(value) || value;
  return VALID_MODELS.has(migrated) ? migrated : "auto";
}

function cleanId(value, fallback) {
  const id = cleanText(value, 80).replace(/[^a-z0-9:_-]/giu, "-");
  return id || fallback;
}

function normalizeProjectRun(value, timestamp) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = cleanText(value.summary, 4000);
  const nextStep = cleanText(value.nextStep, 1200);
  if (!summary && !nextStep) return null;
  return {
    sequence: Math.max(
      0,
      Math.min(Number.parseInt(value.sequence, 10) || 0, 999999),
    ),
    status: VALID_RUN_STATUSES.has(value.status)
      ? value.status
      : "ready_for_next_step",
    summary,
    evidence: (Array.isArray(value.evidence) ? value.evidence : [])
      .slice(0, 8)
      .map((item) => cleanText(item, 500))
      .filter(Boolean),
    nextStep,
    needsUserDecision: value.needsUserDecision === true,
    codeChanged: false,
    updatedAt: cleanText(value.updatedAt, 40) || timestamp,
  };
}

function normalizeProjectDecisions(value, timestamp) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 20)
    .map((item) => ({
      text: cleanText(typeof item === "string" ? item : item?.text, 500),
      createdAt: cleanText(item?.createdAt, 40) || timestamp,
    }))
    .filter((item) => item.text);
}

function normalizeProjectResources(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 30)
    .map((item) => {
      const url = cleanText(item?.url, 1000);
      let safeUrl = "";
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:") safeUrl = parsed.href;
      } catch {
        safeUrl = "";
      }
      return {
        label: cleanText(item?.label, 120) || "Ресурс",
        url: safeUrl,
        type: item?.type === "file" ? "file" : "link",
      };
    })
    .filter((item) => item.url);
}

function normalizeReferenceIds(value, limit) {
  return (Array.isArray(value) ? value : [])
    .slice(0, limit)
    .map((item) => cleanText(item, 80))
    .filter((item) => /^[a-z0-9][a-z0-9:_-]{0,79}$/iu.test(item));
}

function defaultWorkspaceState(now = new Date().toISOString()) {
  return {
    version: WORKSPACE_VERSION,
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
        run: null,
        decisions: [],
        resources: [],
        toolIds: [],
        conversationIds: [],
      },
    ],
    agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
    activities: [],
    preferences: {
      memoryMode: "confirm",
    },
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
        run: normalizeProjectRun(project?.run, timestamp),
        decisions: normalizeProjectDecisions(project?.decisions, timestamp),
        resources: normalizeProjectResources(project?.resources),
        toolIds: normalizeReferenceIds(project?.toolIds, 20),
        conversationIds: normalizeReferenceIds(project?.conversationIds, 50),
      }))
    : fallback.projects;
  const agents = Array.isArray(value.agents)
    ? value.agents.slice(0, 12).map((agent, index) => ({
        id: cleanId(agent?.id, `agent-${index + 1}`),
        name: cleanText(agent?.name, 50) || "Личен агент",
        role: VALID_ROLES.has(agent?.role) ? agent.role : "general",
        model: normalizeAgentModel(agent?.model),
        purpose: cleanText(agent?.purpose, 400),
        engine: VALID_ENGINES.has(agent?.engine) ? agent.engine : "ai-core",
        petId: agentPetId(agent),
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
  const preferences = {
    memoryMode: VALID_MEMORY_MODES.has(value.preferences?.memoryMode)
      ? value.preferences.memoryMode
      : "confirm",
  };

  if (!projects.length) projects.push(...fallback.projects);
  if (!agents.length) agents.push(...fallback.agents);
  if (!agents.some((agent) => agent.engine === "codex") && agents.length < 12) {
    agents.push(fallback.agents.find((agent) => agent.engine === "codex"));
  }
  if ((Number.parseInt(value.version, 10) || 0) < WORKSPACE_VERSION) {
    for (const defaultAgent of fallback.agents) {
      if (agents.length >= 12) break;
      if (!agents.some((agent) => agent.id === defaultAgent.id)) {
        agents.push({ ...defaultAgent });
      }
    }
    for (const defaultAgent of fallback.agents) {
      const existing = agents.find((agent) => agent.id === defaultAgent.id);
      if (existing) {
        Object.assign(existing, {
          name: defaultAgent.name,
          role: defaultAgent.role,
          model: defaultAgent.model,
          purpose: defaultAgent.purpose,
          engine: defaultAgent.engine,
        });
      }
    }
  }

  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? value.activeProjectId
    : projects[0].id;
  const activeAgentId = agents.some((agent) => agent.id === value.activeAgentId)
    ? value.activeAgentId
    : agents[0].id;
  const petId = VALID_PETS.has(value.petId) ? value.petId : "robot";
  if ((Number.parseInt(value.version, 10) || 0) < WORKSPACE_VERSION) {
    const activeAgent = agents.find((agent) => agent.id === activeAgentId);
    if (activeAgent) activeAgent.petId = petId;
  }

  return {
    version: WORKSPACE_VERSION,
    mode: VALID_MODES.has(value.mode) ? value.mode : "chat",
    activeProjectId,
    activeAgentId,
    petId,
    petState: VALID_STATUSES.has(value.petState) ? value.petState : "ready",
    projects,
    agents,
    activities,
    preferences,
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

function getFirestoreStore(env = process.env) {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    env.GOOGLE_CLOUD_PROJECT,
    env.GCLOUD_PROJECT,
    env.GCP_PROJECT_ID,
    env.FIRESTORE_DATABASE_ID,
    env.FIRESTORE_WORKSPACE_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    firestoreStore = createFirestoreWorkspaceStore({ env });
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

function persistenceBackend(env = process.env) {
  const backend = resolvePersistenceBackend(env);
  if (!backend) {
    throw new WorkspaceStateError(
      "Работната област има невалидна storage конфигурация.",
      503,
      "WORKSPACE_STORAGE_UNAVAILABLE",
    );
  }
  return backend;
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
    if (persistenceBackend(env) === "firestore") {
      const document = await getFirestoreStore(env).get(documentId);
      if (!document) {
        return {
          state: normalizeWorkspaceState(null),
          persisted: false,
          updatedAt: null,
        };
      }
      return {
        state: normalizeWorkspaceState(document.data?.state),
        persisted: true,
        updatedAt: document.data?.updatedAt || null,
      };
    }
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
    if (persistenceBackend(env) === "firestore") {
      await getFirestoreStore(env).set(documentId, {
        schemaVersion: 2,
        ownerHash: documentId,
        state,
        updatedAt,
      });
      return { state, persisted: true, updatedAt };
    }
    await requireClient(client).index({
      index: indexName(env),
      id: documentId,
      body: {
        schemaVersion: 2,
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
