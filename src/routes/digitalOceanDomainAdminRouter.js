import express from "express";
import {
  activateDigitalOceanDomainAlias,
  inspectDigitalOceanDomainAlias,
  PUBLIC_WWW_DOMAIN,
} from "../services/digitalOceanService.js";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "../services/confirmationService.js";
import {
  executeAuditedWriteAction,
  recordAuditEvent,
} from "../services/permissionService.js";
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";

export const DIGITALOCEAN_DOMAIN_ACTION =
  "infrastructure.digitalocean:add_www_domain";

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch (error) {
    logSafeError("[DigitalOcean domain audit] Write failure", error);
  }
}

function safeError(error) {
  const status = Number(error?.status);
  const statusByCode = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
    AUDIT_UNAVAILABLE: 503,
    AUDIT_OUTCOME_UNCERTAIN: 502,
  };
  const resolvedStatus =
    status >= 400 && status < 600 ? status : statusByCode[error?.code] || 500;
  const safeCodes = new Set([
    "AUDIT_UNAVAILABLE",
    "AUDIT_OUTCOME_UNCERTAIN",
    "DIGITALOCEAN_NOT_CONFIGURED",
    "DIGITALOCEAN_APP_NOT_CONFIGURED",
    "DIGITALOCEAN_TOKEN_INVALID",
    "DIGITALOCEAN_FORBIDDEN",
    "DIGITALOCEAN_APP_UPDATE_FORBIDDEN",
    "DIGITALOCEAN_APP_SPEC_REJECTED",
    "DIGITALOCEAN_SECRET_ROUND_TRIP_UNSAFE",
    "DIGITALOCEAN_DOMAIN_NOT_ALLOWED",
    "DIGITALOCEAN_APP_CHANGED",
    "DIGITALOCEAN_APP_RESOLUTION_FAILED",
    "DIGITALOCEAN_APP_RESOLUTION_AMBIGUOUS",
    "DIGITALOCEAN_NETWORK_ERROR",
    "DIGITALOCEAN_UPSTREAM_ERROR",
  ]);
  return {
    status: resolvedStatus,
    body: {
      error:
        safeCodes.has(error?.code) ||
        (resolvedStatus >= 400 && resolvedStatus < 500)
          ? error.message
          : "Настройването на www адреса не успя.",
      code: error?.code || "DIGITALOCEAN_DOMAIN_ACTIVATION_FAILED",
    },
  };
}

export function createDigitalOceanDomainAdminRouter({
  inspect = inspectDigitalOceanDomainAlias,
  activate = activateDigitalOceanDomainAlias,
  createConfirmation = createDurableConfirmation,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  audit = recordAuditEvent,
  executeWrite = executeAuditedWriteAction,
  domain = PUBLIC_WWW_DOMAIN,
} = {}) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  });

  router.get("/status", async (_req, res) => {
    try {
      const status = await inspect({ domain });
      return res.json({
        configured: status.configured,
        domain: status.domain,
        readAccessVerified: status.readAccessVerified,
        requiredWriteScope: status.requiredWriteScope,
      });
    } catch (error) {
      const response = safeError(error);
      return res.status(response.status).json(response.body);
    }
  });

  router.post("/prepare", async (req, res) => {
    try {
      const status = await inspect({ domain });
      if (status.configured) {
        return res.json({
          configured: true,
          domain: status.domain,
          readAccessVerified: status.readAccessVerified,
        });
      }
      const confirmation = await createConfirmation({
        sessionId: req.owner.id,
        action: DIGITALOCEAN_DOMAIN_ACTION,
        resource: {
          appId: status.appId,
          domain: status.domain,
        },
        params: { domain: status.domain },
      });
      await safeAudit(audit, {
        actor: req.owner.id,
        action: DIGITALOCEAN_DOMAIN_ACTION,
        decision: "confirm",
        outcome: "requested",
        resource: status.domain,
        details: "add_www_domain_alias",
      });
      return res.status(201).json({
        confirmationId: confirmation.id,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
        domain: status.domain,
        readAccessVerified: status.readAccessVerified,
        requiredWriteScope: status.requiredWriteScope,
        message:
          "Проверката на DigitalOcean е успешна. Ще бъде добавен само www адресът, без изтриване или промяна на съществуващите домейни.",
      });
    } catch (error) {
      const response = safeError(error);
      return res.status(response.status).json(response.body);
    }
  });

  router.post("/confirm", async (req, res) => {
    const confirmationId =
      typeof req.body?.confirmationId === "string"
        ? req.body.confirmationId.trim()
        : "";
    if (!confirmationId) {
      return res.status(400).json({
        error: "Липсва точно потвърждение.",
        code: "MISSING_CONFIRMATION_ID",
      });
    }
    try {
      const confirmation = await validateConfirmation(
        confirmationId,
        req.owner.id,
      );
      if (confirmation.action !== DIGITALOCEAN_DOMAIN_ACTION) {
        return res.status(400).json({
          error: "Потвърждението е за друго действие.",
          code: "CONFIRMATION_ACTION_MISMATCH",
        });
      }
      if (confirmation.resource.domain !== domain) {
        return res.status(409).json({
          error: "Потвърждението е за друг домейн.",
          code: "CONFIRMATION_DOMAIN_MISMATCH",
        });
      }
      await consumeConfirmation(confirmationId);
      const result = await executeWrite({
        action: DIGITALOCEAN_DOMAIN_ACTION,
        capability: "infrastructure.write",
        actor: req.owner.id,
        sessionId: req.owner.id,
        confirmationId,
        resource: confirmation.resource.domain,
        details: "add_www_domain_alias",
        execute: () =>
          activate({
            domain: confirmation.resource.domain,
            expectedAppId: confirmation.resource.appId,
          }),
      });
      return res.json({
        status: "ok",
        updated: result.updated,
        domain: result.domain,
        deploymentId: result.deploymentId,
      });
    } catch (error) {
      await safeAudit(audit, {
        actor: req.owner.id,
        action: DIGITALOCEAN_DOMAIN_ACTION,
        decision: "confirmed",
        outcome: "failed",
        resource: domain,
        details: safeErrorCode(error, "DIGITALOCEAN_DOMAIN_ACTIVATION_FAILED"),
      });
      const response = safeError(error);
      return res.status(response.status).json(response.body);
    }
  });

  return router;
}

export default createDigitalOceanDomainAdminRouter();
