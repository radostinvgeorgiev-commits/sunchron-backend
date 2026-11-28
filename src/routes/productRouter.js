import express from "express";
import {
  PRODUCT_PLANS,
  getProductPlansService,
  productAccountId,
} from "../services/productPlansService.js";
import {
  paymentMode,
  paymentsEnabled,
  paymentsAvailableFor,
  createProductCheckout,
  verifyPaymentEvent,
  handlePaymentEvent,
  isCheckoutSessionId,
} from "../services/productPaymentService.js";
import { requireOwnerSession } from "../middleware/ownerAuth.js";
import { createApiRateLimiter } from "../middleware/rateLimits.js";
function failure(res, error) {
  return res
    .status(error.status || 503)
    .json({
      code: error.code || "PRODUCT_UNAVAILABLE",
      error: error.code
        ? error.message
        : "Потреблението временно не е достъпно.",
    });
}
function ownAccountId(identity) {
  try {
    return productAccountId(identity);
  } catch {
    return null;
  }
}
export function createProductRouter() {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/plans", (_req, res) =>
    res.json({
      plans: PRODUCT_PLANS,
      paymentsEnabled: paymentsEnabled(),
      currency: "EUR",
      renewal: "manual",
      ordinaryRequestCredits: 3,
      councilRequestCredits: 18,
    }),
  );
  router.get("/usage", requireOwnerSession, async (req, res) => {
    try {
      const usage = await getProductPlansService().usage(req.owner);
      res.json({
        ...usage,
        // The person's own anonymous account number. It is what goes into
        // PRODUCT_PAYMENTS_TEST_ACCOUNTS to allow a test-money purchase.
        account: ownAccountId(req.owner),
        payments: {
          mode: paymentMode(),
          available: paymentsAvailableFor(req.owner),
        },
      });
    } catch (e) {
      failure(res, e);
    }
  });
  router.get(
    "/payment-status",
    requireOwnerSession,
    createApiRateLimiter({ limit: 120 }),
    async (req, res) => {
      if (!isCheckoutSessionId(req.query.session))
        return res
          .status(400)
          .json({ error: "Невалидно плащане.", code: "PAYMENT_SESSION_INVALID" });
      try {
        res.json(
          await getProductPlansService().paymentStatus(
            req.owner,
            req.query.session,
          ),
        );
      } catch (e) {
        failure(res, e);
      }
    },
  );
  router.post(
    "/checkout",
    requireOwnerSession,
    createApiRateLimiter({ limit: 5 }),
    async (req, res) => {
      if (req.body?.confirmed !== true)
        return res
          .status(400)
          .json({
            error: "Потвърди точния план и цената.",
            code: "PAYMENT_CONFIRMATION_REQUIRED",
          });
      try {
        res.json(
          await createProductCheckout(req.owner, req.body.plan, {
            host: req.get("host"),
            language:
              typeof req.body.language === "string"
                ? req.body.language
                : undefined,
          }),
        );
      } catch (e) {
        failure(res, e);
      }
    },
  );
  return router;
}
export async function productWebhook(req, res) {
  try {
    if (paymentMode() === "off")
      return res.status(503).json({ error: "Плащанията не са активирани." });
    const event = verifyPaymentEvent(req.body, req.headers["stripe-signature"]);
    await handlePaymentEvent(event, {
      fulfill: (session, options) =>
        getProductPlansService().fulfill(session, options),
    });
    return res.json({ received: true });
  } catch (e) {
    return failure(res, e);
  }
}
