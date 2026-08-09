import { createHash, randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";
import { resolvePersistenceBackend } from "../config/memoryBackend.js";
import { createFirestoreOperationalStore } from "./firestoreOperationalStore.js";

const AUDIT_INDEX = process.env.AUDIT_INDEX || "synchron-action-audit";
const MAX_FALLBACK_EVENTS = 500;
const fallbackEvents = [];
let firestoreOperationalStore = null;
let firestoreOperationalConfiguration = null;
let firestoreOperationalStoreOverride = null;

export function setFirestoreAuditStoreForTests(store) {
  firestoreOperationalStoreOverride = store || null;
  firestoreOperationalStore = null;
  firestoreOperationalConfiguration = null;
}

const POLICY = Object.freeze({
  "github.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "GitHub достъпът е ограничен само до четене.",
  }),
  "github.write": Object.freeze({
    decision: "confirm",
    risk: "medium",
    reason: "Промените в GitHub изискват отделно разрешение.",
  }),
  "code.execute.read": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason:
      "Codex работи в изолирано копие на кода без запис и без мрежов достъп.",
  }),
  "calendar.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Четенето на собствения календар е разрешено.",
  }),
  "calendar.write": Object.freeze({
    decision: "confirm",
    risk: "medium",
    reason: "Промените в календара изискват отделно потвърждение.",
  }),
  "drive.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Четенето е ограничено до изрично свързания Google Drive.",
  }),
  "mail.read": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason: "Четенето е ограничено до изрично свързания Gmail.",
  }),
  "mail.draft": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason: "Черновата не изпраща съобщение и остава видима за преглед.",
  }),
  "mail.send": Object.freeze({
    decision: "confirm",
    risk: "high",
    reason: "Изпращането на имейл изисква отделно точно потвърждение.",
  }),
  "mail.delete": Object.freeze({
    decision: "confirm",
    risk: "high",
    reason: "Преместването на имейл в кошчето изисква потвърждение.",
  }),
  "contacts.read": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason: "Търсенето е ограничено до изрично свързаните Google контакти.",
  }),
  "contacts.write": Object.freeze({
    decision: "confirm",
    risk: "high",
    reason: "Добавянето или промяната на контакт изисква потвърждение.",
  }),
  "tasks.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Четенето е ограничено до задачите на текущия профил.",
  }),
  "tasks.draft": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Черновите и бележките са обратими и не стартират външно действие.",
  }),
  "tasks.update": Object.freeze({
    decision: "confirm",
    risk: "medium",
    reason: "Промяната на статус на задача изисква точно потвърждение.",
  }),
  "web.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Интернет търсенето е само за четене.",
  }),
  "database.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Supabase достъпът е ограничен само до проверка на статуса.",
  }),
  "infrastructure.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason:
      "Инфраструктурният достъп е ограничен само до статус и диагностика.",
  }),
  "image.read": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason: "Анализира се само снимката, изпратена от Радко.",
  }),
  "memory.read": Object.freeze({
    decision: "allow",
    risk: "low",
    reason: "Четенето на собствената памет е разрешено.",
  }),
  "memory.test": Object.freeze({
    decision: "allow",
    risk: "low",
    reason:
      "Автоматичният тест използва отделен временен собственик и не променя истинската памет.",
  }),
  "memory.write": Object.freeze({
    decision: "confirm",
    risk: "medium",
    reason: "Записът в постоянната памет изисква изрично потвърждение.",
  }),
  "memory.delete": Object.freeze({
    decision: "confirm",
    risk: "high",
    reason: "Изтриването на постоянна памет изисква потвърждение.",
  }),
  "agent.chat": Object.freeze({
    decision: "allow",
    risk: "medium",
    reason:
      "Разговорът е ограничен до собствения AI CORE профил и не изпълнява външни действия.",
  }),
  "external.send": Object.freeze({
    decision: "confirm",
    risk: "high",
    reason:
      "Изпращането или публикуването от името на Радко изисква потвърждение.",
  }),
  payment: Object.freeze({
    decision: "confirm",
    risk: "critical",
    reason: "Плащане, покупка или резервация изисква потвърждение.",
  }),
});

function cleanText(value, fallback = null) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function evaluatePermission(action) {
  const cleanAction = cleanText(action);
  const policy = cleanAction ? POLICY[cleanAction] : null;
  if (policy) return { action: cleanAction, ...policy };
  return {
    action: cleanAction || "unknown",
    decision: "deny",
    risk: "unknown",
    reason:
      "Действието не е описано в разрешенията и е блокирано по подразбиране.",
  };
}

export function listPermissions() {
  return Object.entries(POLICY).map(([action, policy]) => ({
    action,
    ...policy,
  }));
}

function referenceFingerprint(value) {
  const text = cleanText(value);
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

function buildAuditEntry(event) {
  const permission = evaluatePermission(event.action);
  return {
    id: randomUUID(),
    auditId: cleanText(event.auditId),
    timestamp: new Date().toISOString(),
    actor: cleanText(event.actor, "synchron-x"),
    action: permission.action,
    capability: cleanText(event.capability),
    decision: cleanText(event.decision, permission.decision),
    phase: cleanText(event.phase),
    outcome: cleanText(event.outcome, "attempted"),
    resource: cleanText(event.resource),
    details: cleanText(event.details),
    sessionId: cleanText(event.sessionId),
    confirmationRef: referenceFingerprint(event.confirmationId),
  };
}

async function persistOpenSearchAuditEntry(client, entry) {
  await client.index({
    index: AUDIT_INDEX,
    id: entry.id,
    body: entry,
    refresh: true,
  });
}

function getFirestoreOperationalStoreOrThrow() {
  if (firestoreOperationalStoreOverride) {
    return firestoreOperationalStoreOverride;
  }
  const configuration = [
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.GCLOUD_PROJECT,
    process.env.GCP_PROJECT_ID,
    process.env.FIRESTORE_DATABASE_ID,
    process.env.FIRESTORE_AUDIT_COLLECTION,
  ].join("\0");
  if (
    !firestoreOperationalStore ||
    firestoreOperationalConfiguration !== configuration
  ) {
    firestoreOperationalStore = createFirestoreOperationalStore({
      env: process.env,
    });
    firestoreOperationalConfiguration = configuration;
  }
  return firestoreOperationalStore;
}

async function persistConfiguredAuditEntry(entry) {
  const backend = resolvePersistenceBackend(process.env);
  if (backend === "firestore") {
    await getFirestoreOperationalStoreOrThrow().saveAuditEntry(entry.id, entry);
    return true;
  }
  if (backend !== "opensearch") return false;
  const client = getOpenSearchClient();
  if (!client) return false;
  await persistOpenSearchAuditEntry(client, entry);
  return true;
}

export class AuditSafetyError extends Error {
  constructor(message, code, status = 503, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AuditSafetyError";
    this.code = code;
    this.status = status;
    this.auditId = options.auditId || null;
    this.result = options.result;
  }
}

export function isAuditSafetyError(error) {
  return error instanceof AuditSafetyError;
}

export async function recordAuditEvent(event) {
  const entry = buildAuditEntry(event);
  const persisted = await persistConfiguredAuditEntry(entry);
  if (!persisted) {
    fallbackEvents.unshift(entry);
    if (fallbackEvents.length > MAX_FALLBACK_EVENTS) fallbackEvents.pop();
  }
  return entry;
}

export async function recordDurableAuditEvent(event) {
  const entry = buildAuditEntry(event);
  try {
    const persisted = await persistConfiguredAuditEntry(entry);
    if (!persisted) {
      throw new Error("persistent audit backend unavailable");
    }
  } catch (error) {
    throw new AuditSafetyError(
      "Устойчивият журнал не е достъпен.",
      "AUDIT_UNAVAILABLE",
      503,
      { cause: error },
    );
  }
  return entry;
}

export async function executeAuditedWriteAction({
  action,
  capability,
  actor,
  sessionId,
  confirmationId,
  resource,
  details,
  execute,
  writeAudit,
}) {
  if (typeof execute !== "function") {
    throw new TypeError("Audit write action: липсва изпълнима функция.");
  }

  const auditId = randomUUID();
  const audit =
    typeof writeAudit === "function" ? writeAudit : recordDurableAuditEvent;
  const baseEvent = {
    auditId,
    actor,
    action,
    capability,
    decision: "confirmed",
    resource,
    details,
    sessionId,
    confirmationId,
  };

  try {
    await audit({
      ...baseEvent,
      phase: "intent",
      outcome: "intent",
    });
  } catch (error) {
    throw new AuditSafetyError(
      "Журналът не е достъпен. Действието не беше стартирано.",
      "AUDIT_UNAVAILABLE",
      503,
      { auditId, cause: error },
    );
  }

  let result;
  try {
    result = await execute();
  } catch (executionError) {
    try {
      await audit({
        ...baseEvent,
        phase: "outcome",
        outcome: "failed",
        details: cleanText(executionError?.code, "WRITE_ACTION_FAILED"),
      });
    } catch (auditError) {
      throw new AuditSafetyError(
        "Действието върна грешка, но крайният журнал не можа да бъде записан. Провери състоянието преди повторение.",
        "AUDIT_OUTCOME_UNCERTAIN",
        502,
        { auditId, cause: auditError },
      );
    }
    throw executionError;
  }

  try {
    await audit({
      ...baseEvent,
      phase: "outcome",
      outcome: "succeeded",
    });
  } catch (error) {
    throw new AuditSafetyError(
      "Действието може да е извършено, но крайният журнал не можа да бъде записан. Не го повтаряй автоматично.",
      "AUDIT_OUTCOME_UNCERTAIN",
      502,
      { auditId, result, cause: error },
    );
  }

  return result;
}

export async function listAuditEvents(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  if (resolvePersistenceBackend(process.env) === "firestore") {
    return getFirestoreOperationalStoreOrThrow().listAuditEntries(safeLimit);
  }
  const client = getOpenSearchClient();
  if (!client) return fallbackEvents.slice(0, safeLimit);

  const response = await client.search({
    index: AUDIT_INDEX,
    body: {
      size: safeLimit,
      sort: [{ timestamp: { order: "desc" } }],
      query: { match_all: {} },
    },
  });
  return (response.body?.hits?.hits || []).map((hit) => hit._source);
}

export function resetAuditFallbackForTests() {
  fallbackEvents.length = 0;
  setFirestoreAuditStoreForTests(null);
}
