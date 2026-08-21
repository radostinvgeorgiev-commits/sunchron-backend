import { createHash, randomUUID } from "node:crypto";

import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreTaskRunStore } from "./firestoreTaskRunStore.js";

const MAX_TITLE_LENGTH = 240;
const MAX_SESSION_ID_LENGTH = 160;
const MAX_REASON_LENGTH = 1_000;
const MAX_CHECKPOINT_MESSAGE_LENGTH = 2_000;
const MAX_STEPS = 50;
const MAX_CHECKPOINTS = 100;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,159}$/iu;

export const TASK_RUN_STATUSES = Object.freeze([
  "queued",
  "planning",
  "running",
  "paused",
  "waiting_confirmation",
  "partial",
  "completed",
  "failed",
  "cancelled",
]);

const STATUS_SET = new Set(TASK_RUN_STATUSES);
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["planning", "running", "paused", "cancelled"]),
  planning: new Set(["running", "paused", "failed", "cancelled"]),
  running: new Set([
    "planning",
    "paused",
    "waiting_confirmation",
    "partial",
    "completed",
    "failed",
    "cancelled",
  ]),
  paused: new Set(["planning", "running", "cancelled"]),
  waiting_confirmation: new Set([
    "planning",
    "running",
    "paused",
    "partial",
    "completed",
    "failed",
    "cancelled",
  ]),
  failed: new Set(["planning", "running", "paused", "cancelled"]),
  partial: new Set(["planning", "running", "paused", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
});

let firestoreStore = null;
let firestoreConfiguration = null;
let firestoreStoreOverride = null;

export class TaskRunError extends Error {
  constructor(message, status = 400, code = "TASK_RUN_ERROR") {
    super(message);
    this.name = "TaskRunError";
    this.status = status;
    this.code = code;
  }
}

export function setFirestoreTaskRunStoreForTests(store) {
  firestoreStoreOverride = store || null;
  firestoreStore = null;
  firestoreConfiguration = null;
}

function cleanText(value, maxLength, label, { required = false } = {}) {
  const clean =
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim()
      : "";
  if (required && !clean) {
    throw new TaskRunError(`Липсва ${label}.`, 400, "TASK_RUN_FIELD_MISSING");
  }
  if (clean.length > maxLength) {
    throw new TaskRunError(
      `${label} е прекалено дълго.`,
      400,
      "TASK_RUN_FIELD_TOO_LONG",
    );
  }
  return clean;
}

function cleanId(value, label, { optional = false } = {}) {
  const clean = cleanText(value, 160, label, { required: !optional });
  if (!clean && optional) return "";
  if (!SAFE_ID_PATTERN.test(clean)) {
    throw new TaskRunError(`Невалидно ${label}.`, 400, "TASK_RUN_ID_INVALID");
  }
  return clean;
}

function cleanStatus(value) {
  const status = cleanText(value, 40, "статус", { required: true });
  if (!STATUS_SET.has(status)) {
    throw new TaskRunError(
      "Неподдържан статус на изпълнение.",
      400,
      "TASK_RUN_STATUS_INVALID",
    );
  }
  return status;
}

function ownerHash(ownerId) {
  const cleanOwnerId = cleanText(ownerId, 200, "проверен профил", {
    required: true,
  });
  return createHash("sha256")
    .update("synchron-task-owner-v1\0")
    .update(cleanOwnerId)
    .digest("hex");
}

function getStore(env = process.env) {
  if (firestoreStoreOverride) return firestoreStoreOverride;
  const configuration = [
    env.GOOGLE_CLOUD_PROJECT,
    env.GCLOUD_PROJECT,
    env.GCP_PROJECT_ID,
    env.FIRESTORE_DATABASE_ID,
    env.FIRESTORE_TASK_RUN_COLLECTION,
  ].join("\0");
  if (!firestoreStore || firestoreConfiguration !== configuration) {
    firestoreStore = createFirestoreTaskRunStore({ env });
    firestoreConfiguration = configuration;
  }
  return firestoreStore;
}

function requireFirestore(env) {
  if (resolvePersistenceBackend(env) !== "firestore") {
    throw new TaskRunError(
      "Устойчивите изпълнения временно изискват Firestore.",
      503,
      "TASK_RUN_STORAGE_UNAVAILABLE",
    );
  }
  return getStore(env);
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_STEPS).map((step, index) => {
    const title =
      typeof step === "string"
        ? step
        : step?.title || step?.message || `Стъпка ${index + 1}`;
    return {
      id: `step-${index + 1}`,
      title: cleanText(title, MAX_CHECKPOINT_MESSAGE_LENGTH, "стъпка", {
        required: true,
      }),
      status: "pending",
    };
  });
}

function checkpointFromInput({ status, stepIndex, message, source, at }) {
  return Object.freeze({
    at,
    status,
    stepIndex,
    message: cleanText(message, MAX_CHECKPOINT_MESSAGE_LENGTH, "описание", {
      required: true,
    }),
    source: cleanText(source, 80, "източник") || "orchestrator",
  });
}

function taskRunFromData(id, data = {}) {
  return Object.freeze({
    id,
    title: data.title || "AI задача",
    sessionId: data.sessionId || null,
    mode: data.mode || "chat",
    status: STATUS_SET.has(data.status) ? data.status : "queued",
    currentStep: Number.isInteger(data.currentStep) ? data.currentStep : 0,
    pausedReason: data.pausedReason || null,
    waitingConfirmation: data.waitingConfirmation || null,
    steps: Object.freeze(
      (Array.isArray(data.steps) ? data.steps : []).map((step) =>
        Object.freeze({
          id: step.id,
          title: step.title,
          status: step.status || "pending",
        }),
      ),
    ),
    checkpoints: Object.freeze(
      (Array.isArray(data.checkpoints) ? data.checkpoints : []).map((item) =>
        Object.freeze({ ...item }),
      ),
    ),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  });
}

async function loadOwnedTaskRun(ownerId, runId, env) {
  const id = cleanId(runId, "runId");
  const document = await requireFirestore(env).get(id);
  if (!document || document.data?.ownerHash !== ownerHash(ownerId)) {
    throw new TaskRunError(
      "Изпълнението не е намерено.",
      404,
      "TASK_RUN_NOT_FOUND",
    );
  }
  return { id, data: document.data };
}

function saveTaskRun(id, data, env) {
  return requireFirestore(env).set(id, data);
}

function timestamp(now) {
  const value = now();
  return typeof value === "string" ? value : new Date(value).toISOString();
}

export async function createTaskRun(
  {
    ownerId,
    sessionId,
    title,
    mode = "chat",
    steps = [],
  } = {},
  {
    env = process.env,
    now = () => new Date().toISOString(),
    createId = randomUUID,
  } = {},
) {
  const id = cleanId(`run-${createId()}`, "runId");
  const at = timestamp(now);
  const normalizedSteps = normalizeSteps(steps);
  const data = {
    id,
    ownerHash: ownerHash(ownerId),
    sessionId: cleanText(sessionId, MAX_SESSION_ID_LENGTH, "sessionId"),
    title: cleanText(title, MAX_TITLE_LENGTH, "заглавие", { required: true }),
    mode: cleanText(mode, 40, "режим") || "chat",
    status: "queued",
    currentStep: 0,
    pausedReason: null,
    waitingConfirmation: null,
    steps: normalizedSteps,
    checkpoints: [
      checkpointFromInput({
        at,
        status: "queued",
        stepIndex: 0,
        message: "Задачата е създадена и чака планиране.",
        source: "orchestrator",
      }),
    ],
    createdAt: at,
    updatedAt: at,
  };
  await saveTaskRun(id, data, env);
  return taskRunFromData(id, data);
}

export async function listTaskRuns(
  { ownerId, status, limit = 50 } = {},
  { env = process.env } = {},
) {
  const cleanStatusValue = status ? cleanStatus(status) : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const documents = await requireFirestore(env).listByOwner(
    ownerHash(ownerId),
    1_000,
  );
  const runs = documents
    .map(({ id, data }) => taskRunFromData(id, data))
    .filter((run) => !cleanStatusValue || run.status === cleanStatusValue)
    .sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
    )
    .slice(0, safeLimit);
  return Object.freeze(runs);
}

export async function getTaskRun(
  { ownerId, runId } = {},
  { env = process.env } = {},
) {
  const { id, data } = await loadOwnedTaskRun(ownerId, runId, env);
  return taskRunFromData(id, data);
}

export async function recordTaskRunCheckpoint(
  {
    ownerId,
    runId,
    status,
    stepIndex = 0,
    message,
    source = "orchestrator",
    waitingConfirmation = null,
  } = {},
  { env = process.env, now = () => new Date().toISOString() } = {},
) {
  const cleanNextStatus = cleanStatus(status);
  const safeStepIndex = Math.max(0, Math.min(Number(stepIndex) || 0, MAX_STEPS));
  const { id, data: current } = await loadOwnedTaskRun(ownerId, runId, env);
  const currentStatus = STATUS_SET.has(current.status)
    ? current.status
    : "queued";
  if (
    cleanNextStatus !== currentStatus &&
    !TRANSITIONS[currentStatus]?.has(cleanNextStatus)
  ) {
    throw new TaskRunError(
      `Изпълнението не може да премине от ${currentStatus} към ${cleanNextStatus}.`,
      409,
      "TASK_RUN_INVALID_TRANSITION",
    );
  }
  const at = timestamp(now);
  const checkpoint = checkpointFromInput({
    at,
    status: cleanNextStatus,
    stepIndex: safeStepIndex,
    message,
    source,
  });
  const steps = (Array.isArray(current.steps) ? current.steps : []).map(
    (step, index) => ({
      ...step,
      status:
        cleanNextStatus === "completed"
          ? "completed"
          : index < safeStepIndex
            ? "completed"
            : index === safeStepIndex && cleanNextStatus === "running"
              ? "running"
              : step.status || "pending",
    }),
  );
  const updated = {
    ...current,
    id,
    status: cleanNextStatus,
    currentStep: safeStepIndex,
    pausedReason:
      cleanNextStatus === "paused" ? checkpoint.message : null,
    waitingConfirmation:
      cleanNextStatus === "waiting_confirmation"
        ? waitingConfirmation || current.waitingConfirmation || null
        : null,
    steps,
    checkpoints: [
      ...(Array.isArray(current.checkpoints) ? current.checkpoints : []),
      checkpoint,
    ].slice(-MAX_CHECKPOINTS),
    updatedAt: at,
  };
  await saveTaskRun(id, updated, env);
  return taskRunFromData(id, updated);
}

export async function pauseTaskRun(
  { ownerId, runId, reason } = {},
  options = {},
) {
  return recordTaskRunCheckpoint(
    {
      ownerId,
      runId,
      status: "paused",
      message: cleanText(reason, MAX_REASON_LENGTH, "причина за пауза", {
        required: true,
      }),
      source: "user",
    },
    options,
  );
}

export async function resumeTaskRun(
  { ownerId, runId } = {},
  options = {},
) {
  const current = await getTaskRun({ ownerId, runId }, options);
  const nextStatus = current.status === "failed" ? "planning" : "running";
  return recordTaskRunCheckpoint(
    {
      ownerId,
      runId,
      status: nextStatus,
      stepIndex: current.currentStep,
      message: "Задачата продължава от последния запазен checkpoint.",
      source: "user",
    },
    options,
  );
}

export async function cancelTaskRun(
  { ownerId, runId } = {},
  options = {},
) {
  return recordTaskRunCheckpoint(
    {
      ownerId,
      runId,
      status: "cancelled",
      message: "Задачата е спряна по искане на потребителя.",
      source: "user",
    },
    options,
  );
}
