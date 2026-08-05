import express from "express";
import {
  BillingError,
  getTokenBalance,
  getTransactions,
  isBillingConfigured,
  purchaseTokens,
} from "../services/billingService.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();

function sendBillingError(res, error) {
  const known = error instanceof BillingError;
  const status = known ? error.status : 500;
  return res.status(status).json({
    error: known
      ? error.message
      : "Billing услугата временно не е достъпна. Опитай отново.",
    code: known ? error.code : "BILLING_UNEXPECTED_ERROR",
  });
}

/**
 * GET /api/billing/balance
 * Returns the current token balance for the authenticated user.
 */
router.get("/balance", async (req, res) => {
  try {
    const userId = req.owner?.id;
    if (!userId) {
      return res.status(401).json({
        error: "Трябва да влезеш в профила си, за да видиш баланса.",
        code: "AUTH_REQUIRED",
      });
    }
    if (!isBillingConfigured()) {
      return res.json({
        configured: false,
        userId,
        tokens: null,
        message: "Billing системата все още не е конфигурирана.",
      });
    }
    const balance = await getTokenBalance(userId);
    return res.json({
      configured: true,
      userId: balance.userId,
      tokens: balance.tokens,
      lastUpdated: balance.lastUpdated,
    });
  } catch (error) {
    logSafeError("[Billing balance]", error);
    return sendBillingError(res, error);
  }
});

/**
 * GET /api/billing/transactions
 * Returns recent transactions for the authenticated user.
 * Query param: limit (1–100, default 20)
 */
router.get("/transactions", async (req, res) => {
  try {
    const userId = req.owner?.id;
    if (!userId) {
      return res.status(401).json({
        error: "Трябва да влезеш в профила си, за да видиш транзакциите.",
        code: "AUTH_REQUIRED",
      });
    }
    if (!isBillingConfigured()) {
      return res.json({ configured: false, transactions: [] });
    }
    const limit = req.query.limit;
    const transactions = await getTransactions(userId, { limit });
    return res.json({ configured: true, transactions });
  } catch (error) {
    logSafeError("[Billing transactions]", error);
    return sendBillingError(res, error);
  }
});

/**
 * POST /api/billing/purchase-tokens
 * Body: { amount: number, description?: string }
 *
 * NOTE: In a production system this endpoint must be protected by a payment
 * provider webhook (Stripe, etc.).  For now it is owner-only and allows
 * manual top-ups.  Integrate a real payment provider before enabling
 * self-service top-ups for all users.
 */
router.post("/purchase-tokens", async (req, res) => {
  try {
    const userId = req.owner?.id;
    if (!userId) {
      return res.status(401).json({
        error: "Трябва да влезеш в профила си, за да закупиш токени.",
        code: "AUTH_REQUIRED",
      });
    }
    if (!isBillingConfigured()) {
      return res.status(503).json({
        error: "Billing системата все още не е конфигурирана.",
        code: "BILLING_NOT_CONFIGURED",
      });
    }

    const rawAmount = req.body?.amount;
    const amount = Math.ceil(Number(rawAmount) || 0);
    if (amount < 1) {
      return res.status(400).json({
        error: "Количеството токени трябва да е положително число.",
        code: "BILLING_BAD_REQUEST",
      });
    }

    const description =
      typeof req.body?.description === "string" && req.body.description.trim()
        ? req.body.description.trim().slice(0, 200)
        : "Покупка на токени";

    const result = await purchaseTokens(userId, amount, { description });
    return res.status(201).json({
      userId: result.userId,
      tokens: result.tokens,
      purchased: amount,
    });
  } catch (error) {
    logSafeError("[Billing purchase]", error);
    return sendBillingError(res, error);
  }
});

export default router;
