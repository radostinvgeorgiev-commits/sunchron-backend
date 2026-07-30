import express from "express";
import { TESTER_AUTH_BOOTSTRAP } from "../config/testerAuthBootstrap.js";
import {
  activateTesterAuthConfiguration,
  getDigitalOceanAppStatus,
  TESTER_AUTH_ENV_KEYS,
} from "../services/digitalOceanService.js";
import {
  createDurableConfirmation,
  markDurableConfirmationUsed,
  validateDurableConfirmation,
} from "../services/confirmationService.js";
import { recordAuditEvent } from "../services/permissionService.js";
import {
  isTesterRegistrationEnabled,
  isUserAuthConfigured,
} from "../services/userAuthService.js";

const ACTION = "infrastructure.digitalocean:activate_tester_auth";

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch (error) {
    console.error(
      "[Tester auth audit]",
      error?.message || "Audit storage unavailable.",
    );
  }
}

function safeError(error) {
  const status = Number(error?.status);
  const statusByCode = {
    CONFIRMATION_NOT_FOUND: 404,
    CONFIRMATION_EXPIRED: 410,
    SESSION_MISMATCH: 403,
    CONFIRMATION_PERSISTENCE_FAILED: 503,
  };
  const resolvedStatus =
    status >= 400 && status < 600 ? status : statusByCode[error?.code] || 500;
  return {
    status: resolvedStatus,
    body: {
      error:
        resolvedStatus >= 400 && resolvedStatus < 500
          ? error.message
          : "Активирането на тестовите профили не успя.",
      code: error?.code || "TESTER_AUTH_ACTIVATION_FAILED",
    },
  };
}

export function createTesterAuthAdminRouter({
  getDigitalOceanStatus = getDigitalOceanAppStatus,
  activate = activateTesterAuthConfiguration,
  createConfirmation = createDurableConfirmation,
  validateConfirmation = validateDurableConfirmation,
  consumeConfirmation = markDurableConfirmationUsed,
  audit = recordAuditEvent,
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
    const inviteCode = String(env.SYNCHRON_TEST_INVITE_CODE || "").trim();
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
      const status = await getDigitalOceanStatus();
      const existing = new Set(
        (status.environmentVariables || []).map(({ key }) => key),
      );
      const missingKeys = TESTER_AUTH_ENV_KEYS.filter(
        (key) => !existing.has(key),
      );
      if (!missingKeys.length) {
        return res.json({
          configured: true,
          registrationEnabled: isTesterRegistrationEnabled(env),
          missingKeys: [],
        });
      }
      const confirmation = await createConfirmation({
        sessionId: req.owner.id,
        action: ACTION,
        resource: {
          appId: status.id,
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
        resource: status.id,
        details: `keys:${missingKeys.join(",")}`,
      });
      return res.status(201).json({
        confirmationId: confirmation.id,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
        missingKeys,
        message:
          "Ще добавя само настройките за Supabase тестови профили и ще започне нов DigitalOcean deployment.",
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
      const result = await activate({
        projectUrl: confirmation.params.projectUrl,
        publishableKey: confirmation.params.publishableKey,
        expectedAppId: confirmation.resource.appId,
      });
      await safeAudit(audit, {
        actor: req.owner.id,
        action: ACTION,
        decision: "confirmed",
        outcome: "succeeded",
        resource: result.appId,
        details: `keys:${result.changedKeys.join(",")}`,
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
        details: error?.code || "TESTER_AUTH_ACTIVATION_FAILED",
      });
      const response = safeError(error);
      return res.status(response.status).json(response.body);
    }
  });

  return router;
}

export default createTesterAuthAdminRouter();
