import express from "express";
import {
  BillingError,
  deductTokens,
  getBalance,
  getTransactionHistory,
  purchaseTokens,
} from "../services/billingService.js";
import { resolveRequestIdentity } from "../middleware/ownerAuth.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();

function sendBillingError(res, error) {
  const known = error instanceof BillingError;
  return res.status(known ? error.status : 500).json({
    error: known
      ? error.message
      : "Услугата за плащания временно не е достъпна.",
    code: known ? error.code : "BILLING_UNEXPECTED_ERROR",
  });
}

async function requireAuthenticatedUser(req, res) {
  const identity = await resolveRequestIdentity(req, res);
  if (!identity) {
    res.status(401).json({
      error: "Необходим е вход.",
      code: "AUTH_REQUIRED",
    });
    return null;
  }
  return identity;
}

// GET /api/billing/balance
router.get("/balance", async (req, res) => {
  try {
    const identity = await requireAuthenticatedUser(req, res);
    if (!identity) return;
    const result = await getBalance(identity.id);
    return res.json(result);
  } catch (error) {
    logSafeError("[Billing balance]", error);
    return sendBillingError(res, error);
  }
});

// POST /api/billing/purchase-tokens
// Body: { euros: number, stripePaymentMethodId?: string }
router.post("/purchase-tokens", async (req, res) => {
  try {
    const identity = await requireAuthenticatedUser(req, res);
    if (!identity) return;

    const { euros, stripePaymentMethodId } = req.body || {};
    const result = await purchaseTokens({
      userId: identity.id,
      euros,
      stripePaymentMethodId,
    });
    return res.json(result);
  } catch (error) {
    logSafeError("[Billing purchase]", error);
    return sendBillingError(res, error);
  }
});

// GET /api/billing/history
router.get("/history", async (req, res) => {
  try {
    const identity = await requireAuthenticatedUser(req, res);
    if (!identity) return;

    const limit = Number(req.query.limit) || 20;
    const transactions = await getTransactionHistory(identity.id, limit);
    return res.json({ transactions });
  } catch (error) {
    logSafeError("[Billing history]", error);
    return sendBillingError(res, error);
  }
});

// Internal: POST /api/billing/deduct — called by the chat route
// Body: { userId, cost, description }
router.post("/deduct", async (req, res) => {
  try {
    const { userId, cost, description } = req.body || {};
    const newBalance = await deductTokens(userId, cost, description);
    return res.json({ newBalance });
  } catch (error) {
    return sendBillingError(res, error);
  }
});

export default router;
