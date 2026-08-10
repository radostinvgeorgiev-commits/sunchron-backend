import { createHash, randomUUID } from "node:crypto";

import { getOpenSearchClient } from "../config/opensearch.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "./confirmationService.js";
import { executeAuditedWriteAction } from "./permissionService.js";
import { createFirestoreTaskStore } from "./firestoreTaskStore.js";
import { loadWorkspaceState } from "./workspaceStateService.js";

const DEFAULT_TASK_INDEX = "synchron-tasks-v1";
const TASK_STATUS_ACTION = "tasks.write:update_status";
const VALID_STATUSES = new Set([
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,159}$/iu;
const indexPromises = new WeakMap();
let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;

export function setFirestoreTaskStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}

export class TaskManagementError extends Error {
  constructor(message, status = 400, code = "TASK_MANAGEMENT_ERROR") {
    super(message);
    this.name = "TaskManagementError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength, label, { required = false } = {}) {
  const clean =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
      : "";
  if (required && !clean) {
    throw new TaskManagementError(
      `Липсва ${label}.`,
      400,
      "TASK_FIELD_MISSING",
    );
  }
  if (clean.length > maxLength) {
    throw new TaskManagementError(
      `${label} е прекалено дълго.`,
      400,
      "TASK_FIELD_TOO_LONG",
    );
  }
  return clean;
}

function cleanId(value, label, { optional = false } = {}) {
  const clean = cleanText(value, 160, label, { required: !optional });
  if (!clean && optional) return "";
  if (!SAFE_ID_PATTERN.test(clean)) {
    throw new TaskManagementError(
      `Невалидно ${label}.`,
      400,
      "TASK_ID_INVALID",
    );
  }
  return clean;
}

function cleanStatus(value) {
  const status = cleanText(value, 40, "статус", { required: true });
  if (!VALID_STATUSES.has(status)) {
    throw new TaskManagementError(
      "Неподдържан статус на задача.",
      400,
      "TASK_STATUS_INVALID",
    );
  }
  return status;
}

function ownerFingerprint(ownerId) {
  const cleanOwnerId = cleanText(ownerId, 200, "проверен профил", {
    required: true,
  });
  return createHash("sha256")
    .update("synchron-task-owner-v1\0")
    .update(cleanOwnerId)
    .digest("hex");
}

function taskIndex(env = process.env) {
  return cleanText(env.TASK_INDEX, 120, "TASK_INDEX") || DEFAULT_TASK_INDEX;
}

function requireClient(client = getOpenSearchClient()) {
  if (!client) {
    throw new TaskManagementError(
      "Задачите временно не са достъпни.",
      503,
      "TASK_STORAGE_UNAVAILABLE",
    );
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
    env.FIRESTORE_TASK_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    firestoreStore = createFirestoreTaskStore({ env });
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

function useFirestore(env = process.env) {
  const backend = resolvePersistenceBackend(env);
  if (!backend) {
    throw new TaskManagementError(
      "Задачите имат невалидна storage конфигурация.",
      503,
      "TASK_STORAGE_UNAVAILABLE",
    );
  }
  return backend === "firestore";
}

async function ensureTaskIndex(client, env) {
  if (!client?.indices) return;
  const index = taskIndex(env);
  let indexes = indexPromises.get(client);
  if (!indexes) {
    indexes = new Map();
    indexPromises.set(client, indexes);
  }
  if (!indexes.has(index)) {
    const properties = {
      id: { type: "keyword" },
      ownerHash: { type: "keyword" },
      title: { type: "text" },
      status: { type: "keyword" },
      projectId: { type: "keyword" },
      notes: {
        type: "nested",
        properties: {
          text: { type: "text", index: false },
          createdAt: { type: "date" },
        },
      },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    };
    const promise = (async () => {
      const existsResponse = await client.indices.exists({ index });
      const exists = existsResponse.body ?? existsResponse;
      if (!exists) {
        await client.indices.create({
          index,
          body: { mappings: { properties } },
        });
        return;
      }
      await client.indices.putMapping({
        index,
        body: { properties },
      });
    })().catch((error) => {
      indexes.delete(index);
      throw error;
    });
    indexes.set(index, promise);
  }
  await indexes.get(index);
}

function statusCode(error) {
  return error?.statusCode || error?.meta?.statusCode || error?.status;
}

function taskFromHit(hit) {
  const source = hit?._source || {};
  return Object.freeze({
    id: hit?._id || source.id,
    title: source.title || "Задача",
    status: VALID_STATUSES.has(source.status) ? source.status : "draft",
    projectId: source.projectId || null,
    notes: Object.freeze(
      (Array.isArray(source.notes) ? source.notes : []).map((note) =>
        Object.freeze({
          text: note.text || "",
          createdAt: note.createdAt || null,
        }),
      ),
    ),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  });
}

async function loadOwnedTask(ownerId, taskId, { client, env } = {}) {
  const id = cleanId(taskId, "taskId");
  try {
    if (useFirestore(env)) {
      const document = await getFirestoreStore(env).get(id);
      if (!document) {
        throw new TaskManagementError(
          "Задачата не е намерена.",
          404,
          "TASK_NOT_FOUND",
        );
      }
      if (document.data?.ownerHash !== ownerFingerprint(ownerId)) {
        throw new TaskManagementError(
          "Задачата не е намерена.",
          404,
          "TASK_NOT_FOUND",
        );
      }
      return taskFromHit({ _id: document.id, _source: document.data });
    }
    const storage = requireClient(client);
    await ensureTaskIndex(storage, env);
    const response = await storage.get({
      index: taskIndex(env),
      id,
    });
    const hit = {
      _id: response.body?._id || response._id || id,
      _source: response.body?._source || response._source,
    };
    if (hit._source?.ownerHash !== ownerFingerprint(ownerId)) {
      throw new TaskManagementError(
        "Задачата не е намерена.",
        404,
        "TASK_NOT_FOUND",
      );
    }
    return taskFromHit(hit);
  } catch (error) {
    if (error instanceof TaskManagementError) throw error;
    if (statusCode(error) === 404) {
      throw new TaskManagementError(
        "Задачата не е намерена.",
        404,
        "TASK_NOT_FOUND",
      );
    }
    throw new TaskManagementError(
      "Задачата не можа да бъде прочетена.",
      503,
      "TASK_READ_FAILED",
    );
  }
}

async function saveTaskDocument(task, { client, env }) {
  if (useFirestore(env)) {
    await getFirestoreStore(env).set(task.id, task);
    return;
  }
  const storage = requireClient(client);
  await ensureTaskIndex(storage, env);
  await storage.index({
    index: taskIndex(env),
    id: task.id,
    body: task,
    refresh: true,
  });
}

export async function listTasks(
  { ownerId, status, projectId, unfinished = false, limit = 50 } = {},
  { client, env = process.env } = {},
) {
  const filters = [{ term: { ownerHash: ownerFingerprint(ownerId) } }];
  if (status !== undefined && status !== null && status !== "") {
    filters.push({ term: { status: cleanStatus(status) } });
  }
  const cleanProjectId = cleanId(projectId, "projectId", { optional: true });
  if (cleanProjectId) filters.push({ term: { projectId: cleanProjectId } });
  if (unfinished === true) {
    filters.push({
      bool: { must_not: [{ terms: { status: [...TERMINAL_STATUSES] } }] },
    });
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  try {
    if (useFirestore(env)) {
      let documents = await getFirestoreStore(env).listByOwner(
        ownerFingerprint(ownerId),
        1_000,
      );
      let tasks = documents.map(({ id, data }) =>
        taskFromHit({ _id: id, _source: data }),
      );
      if (status !== undefined && status !== null && status !== "") {
        const clean = cleanStatus(status);
        tasks = tasks.filter((task) => task.status === clean);
      }
      if (cleanProjectId) {
        tasks = tasks.filter((task) => task.projectId === cleanProjectId);
      }
      if (unfinished === true) {
        tasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
      }
      return Object.freeze(
        tasks
          .sort((left, right) =>
            String(right.updatedAt || "").localeCompare(
              String(left.updatedAt || ""),
            ),
          )
          .slice(0, safeLimit),
      );
    }
    const storage = requireClient(client);
    await ensureTaskIndex(storage, env);
    const response = await storage.search({
      index: taskIndex(env),
      body: {
        size: safeLimit,
        sort: [{ updatedAt: { order: "desc" } }],
        query: { bool: { filter: filters } },
      },
    });
    const hits = response.body?.hits?.hits || response.hits?.hits || [];
    return Object.freeze(hits.map(taskFromHit));
  } catch (error) {
    if (statusCode(error) === 404) return Object.freeze([]);
    if (error instanceof TaskManagementError) throw error;
    throw new TaskManagementError(
      "Задачите не можаха да бъдат прочетени.",
      503,
      "TASK_LIST_FAILED",
    );
  }
}

export async function createTaskDraft(
  { ownerId, title, projectId, note } = {},
  {
    client,
    env = process.env,
    now = () => new Date().toISOString(),
    createId = randomUUID,
  } = {},
) {
  const id = cleanId(`task-${createId()}`, "taskId");
  const timestamp = now();
  const cleanNote = cleanText(note, 2000, "бележка");
  const task = {
    id,
    ownerHash: ownerFingerprint(ownerId),
    title: cleanText(title, 240, "заглавие", { required: true }),
    status: "draft",
    projectId: cleanId(projectId, "projectId", { optional: true }) || null,
    notes: cleanNote ? [{ text: cleanNote, createdAt: timestamp }] : [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await saveTaskDocument(task, { client, env });
    return taskFromHit({ _id: id, _source: task });
  } catch (error) {
    if (error instanceof TaskManagementError) throw error;
    throw new TaskManagementError(
      "Черновата на задачата не можа да бъде запазена.",
      503,
      "TASK_DRAFT_SAVE_FAILED",
    );
  }
}

export async function addTaskNote(
  { ownerId, taskId, note } = {},
  { client, env = process.env, now = () => new Date().toISOString() } = {},
) {
  const current = await loadOwnedTask(ownerId, taskId, {
    client,
    env,
  });
  const timestamp = now();
  const updated = {
    id: current.id,
    ownerHash: ownerFingerprint(ownerId),
    title: current.title,
    status: current.status,
    projectId: current.projectId,
    notes: [
      ...current.notes,
      {
        text: cleanText(note, 2000, "бележка", { required: true }),
        createdAt: timestamp,
      },
    ].slice(-50),
    createdAt: current.createdAt,
    updatedAt: timestamp,
  };
  await saveTaskDocument(updated, { client, env });
  return taskFromHit({ _id: current.id, _source: updated });
}

export async function linkTaskToProject(
  { ownerId, taskId, projectId } = {},
  {
    client,
    env = process.env,
    now = () => new Date().toISOString(),
    loadWorkspace = loadWorkspaceState,
  } = {},
) {
  const current = await loadOwnedTask(ownerId, taskId, {
    client,
    env,
  });
  const cleanProjectId = cleanId(projectId, "projectId");
  const workspace = await loadWorkspace(ownerId, { env });
  if (
    !Array.isArray(workspace?.state?.projects) ||
    !workspace.state.projects.some((project) => project.id === cleanProjectId)
  ) {
    throw new TaskManagementError(
      "Проектът не принадлежи на този профил.",
      404,
      "TASK_PROJECT_NOT_FOUND",
    );
  }
  const timestamp = now();
  const updated = {
    id: current.id,
    ownerHash: ownerFingerprint(ownerId),
    title: current.title,
    status: current.status,
    projectId: cleanProjectId,
    notes: current.notes,
    createdAt: current.createdAt,
    updatedAt: timestamp,
  };
  await saveTaskDocument(updated, { client, env });
  return taskFromHit({ _id: current.id, _source: updated });
}

export async function prepareTaskStatusChange(
  { ownerId, sessionId, taskId, status } = {},
  {
    client,
    env = process.env,
    createConfirmation = createDurableConfirmation,
  } = {},
) {
  const task = await loadOwnedTask(ownerId, taskId, { client, env });
  const nextStatus = cleanStatus(status);
  if (task.status === nextStatus) {
    throw new TaskManagementError(
      "Задачата вече е с този статус.",
      409,
      "TASK_STATUS_UNCHANGED",
    );
  }
  const confirmation = await createConfirmation({
    sessionId,
    action: TASK_STATUS_ACTION,
    resource: {
      taskId: task.id,
      ownerFingerprint: ownerFingerprint(ownerId),
      fromStatus: task.status,
      toStatus: nextStatus,
    },
    params: {},
  });
  return Object.freeze({
    confirmationId: confirmation.id,
    expiresAt: confirmation.expiresAt,
    taskId: task.id,
    title: task.title,
    fromStatus: task.status,
    toStatus: nextStatus,
  });
}

export async function confirmTaskStatusChange(
  { ownerId, sessionId, confirmationId } = {},
  {
    client,
    env = process.env,
    now = () => new Date().toISOString(),
    validateConfirmation = validateDurableConfirmation,
    consumeConfirmation = markDurableConfirmationUsed,
    executeWrite = executeAuditedWriteAction,
  } = {},
) {
  const confirmation = await validateConfirmation(confirmationId, sessionId);
  if (confirmation.action !== TASK_STATUS_ACTION) {
    throw new TaskManagementError(
      "Потвърждението не е за промяна на задача.",
      400,
      "TASK_CONFIRMATION_ACTION_MISMATCH",
    );
  }
  if (confirmation.resource?.ownerFingerprint !== ownerFingerprint(ownerId)) {
    throw new TaskManagementError(
      "Профилът не съответства на потвърдената задача.",
      403,
      "TASK_OWNER_MISMATCH",
    );
  }
  const task = await loadOwnedTask(ownerId, confirmation.resource.taskId, {
    client,
    env,
  });
  if (task.status !== confirmation.resource.fromStatus) {
    throw new TaskManagementError(
      "Статусът на задачата е променен след подготовката.",
      409,
      "TASK_STATUS_CHANGED",
    );
  }
  const nextStatus = cleanStatus(confirmation.resource.toStatus);
  await consumeConfirmation(confirmationId);
  return executeWrite({
    action: "tasks.update",
    capability: TASK_STATUS_ACTION,
    actor: "synchron-x-tasks",
    sessionId,
    confirmationId,
    resource: task.id,
    details: `${task.status}:${nextStatus}`,
    execute: async () => {
      const timestamp = now();
      const updated = {
        id: task.id,
        ownerHash: ownerFingerprint(ownerId),
        title: task.title,
        status: nextStatus,
        projectId: task.projectId,
        notes: task.notes,
        createdAt: task.createdAt,
        updatedAt: timestamp,
      };
      await saveTaskDocument(updated, { client, env });
      return taskFromHit({ _id: task.id, _source: updated });
    },
  });
}

export const TASK_MANAGEMENT_STATUSES = Object.freeze([...VALID_STATUSES]);
export const TASK_STATUS_CONFIRMATION_ACTION = TASK_STATUS_ACTION;
