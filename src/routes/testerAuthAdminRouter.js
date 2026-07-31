import express from "express";
import { TESTER_AUTH_BOOTSTRAP } from "../config/testerAuthBootstrap.js";
import {
  activateTesterAuthConfiguration,
  inspectTesterAuthActivation,
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
import {
  getTesterInviteCode,
  isTesterRegistrationEnabled,
  isUserAuthConfigured,
} from "../services/userAuthService.js";
import { logSafeError, safeErrorCode } from "../utils/safeLogging.js";

const ACTION = "infrastructure.digitalocean:activate_tester_auth";

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch (error) {
    logSafeError("[Tester auth audit] Write failure", error);
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
  return {
    status: resolvedStatus,
    body: {
      error:
        error?.name === "DigitalOceanError" ||
        ["AUDIT_UNAVAILABLE", "AUDIT_OUTCOME_UNCERTAIN"].includes(
          error?.code,
        ) ||
        (resolvedStatus >= 400 && resolvedStatus < 500)
          ? error.message
          : "Активирането на тестовите профили не успя.",
      code: error?.code || "TESTER_AUTH_ACTIVATION_FAILED",
    },
  };
}

export function createTesterAuthAdminRouter({
  inspectDigitalOcean = inspectTesterAuthActivation,
  activate = activateTesterAuthConfiguration,
  createConfirmation = createDurableConfirmation,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  audit = recordAuditEvent,
  executeWrite = executeAuditedWriteAction,
  bootstrap = TESTER_AUTH_BOOTSTRAP,
  env = process.env,
} = {}) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
  });

  router.get("/status", (_req, res) =>
    res.json({
      configured: isUserAuthConfigured(env),
      registrationEnabled: isTesterRegistrationEnabled(env),
    }),
  );

  router.get("/invite-code", (req, res) => {
    const inviteCode = getTesterInviteCode(env);
    if (!isTesterRegistrationEnabled(env) || !inviteCode) {
      return res.status(404).json({
        error: "Кодът за тестов достъп още не е активен.",
        code: "TESTER_INVITE_NOT_CONFIGURED",
      });
    }
    return res.json({ inviteCode });
  });

  router.post("/prepare", async (req, res) => {
    try {
      const status = await inspectDigitalOcean({
        projectUrl: bootstrap.projectUrl,
        publishableKey: bootstrap.publishableKey,
      });
      const missingKeys = status.missingKeys;
      if (!missingKeys.length) {
        return res.json({
          configured: true,
          registrationEnabled: isTesterRegistrationEnabled(env),
          missingKeys: [],
          readAccessVerified: status.readAccessVerified,
          requiredWriteScope: status.requiredWriteScope,
          writeAccess: status.writeAccess,
        });
      }
      const confirmation = await createConfirmation({
        sessionId: req.owner.id,
        action: ACTION,
        resource: {
          appId: status.appId,
          environmentKeys: missingKeys.join(","),
        },
        params: {
          projectUrl: bootstrap.projectUrl,
          publishableKey: bootstrap.publishableKey,
        },
      });
      await safeAudit(audit, {
        actor: req.owner.id,
        action: ACTION,
        decision: "confirm",
        outcome: "requested",
        resource: status.appId,
        details: `keys:${missingKeys.join(",")}`,
      });
      return res.status(201).json({
        confirmationId: confirmation.id,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
        missingKeys,
        readAccessVerified: status.readAccessVerified,
        requiredWriteScope: status.requiredWriteScope,
        writeAccess: status.writeAccess,
        message:
          "Предварителната проверка на токена, приложението и app spec-а е успешна. За записа DigitalOcean изисква app:update. Ще добавя само настройките за Supabase тестови профили и ще започне нов deployment.",
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
      if (confirmation.action !== ACTION) {
        return res.status(400).json({
          error: "Потвърждението е за друго действие.",
          code: "CONFIRMATION_ACTION_MISMATCH",
        });
      }
      await consumeConfirmation(confirmationId);
      const result = await executeWrite({
        action: ACTION,
        capability: "infrastructure.write",
        actor: req.owner.id,
        sessionId: req.owner.id,
        confirmationId,
        resource: confirmation.resource.appId,
        details: "activate_tester_auth",
        execute: () =>
          activate({
            projectUrl: confirmation.params.projectUrl,
            publishableKey: confirmation.params.publishableKey,
            expectedAppId: confirmation.resource.appId,
          }),
      });
      return res.json({
        status: "ok",
        updated: result.updated,
        changedKeys: result.changedKeys,
        deploymentId: result.deploymentId,
        inviteCode: result.inviteCode,
      });
    } catch (error) {
      await safeAudit(audit, {
        actor: req.owner.id,
        action: ACTION,
        decision: "confirmed",
        outcome: "failed",
        resource: "tester-auth",
        details: safeErrorCode(error, "TESTER_AUTH_ACTIVATION_FAILED"),
      });
      const response = safeError(error);
      return res.status(response.status).json(response.body);
    }
  });

  return router;
}

export default createTesterAuthAdminRouter();
