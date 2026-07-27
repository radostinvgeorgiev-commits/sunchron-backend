import { recordAuditEvent } from "./permissionService.js";

export async function auditIntegrationEvent(event, loggerLabel = "Audit") {
  try {
    await recordAuditEvent(event);
  } catch (error) {
    console.error(`[${loggerLabel}] Write failure:`, error);
  }
}
