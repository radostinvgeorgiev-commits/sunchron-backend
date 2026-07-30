import { randomUUID } from "node:crypto";
import { getOpenSearchClient } from "../config/opensearch.js";

const AUDIT_INDEX = process.env.AUDIT_INDEX || "synchron-action-audit";
const MAX_FALLBACK_EVENTS = 500;
const fallbackEvents = [];

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
    reason: "Инфраструктурният достъп е ограничен само до статус и диагностика.",
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

export async function recordAuditEvent(event) {
  const permission = evaluatePermission(event.action);
  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    actor: cleanText(event.actor, "synchron-x"),
    action: permission.action,
    decision: cleanText(event.decision, permission.decision),
    outcome: cleanText(event.outcome, "attempted"),
    resource: cleanText(event.resource),
    details: cleanText(event.details),
    sessionId: cleanText(event.sessionId),
  };

  const client = getOpenSearchClient();
  if (client) {
    await client.index({
      index: AUDIT_INDEX,
      id: entry.id,
      body: entry,
      refresh: true,
    });
  } else {
    fallbackEvents.unshift(entry);
    if (fallbackEvents.length > MAX_FALLBACK_EVENTS) fallbackEvents.pop();
  }
  return entry;
}

export async function listAuditEvents(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
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
}
