import express from "express";
import {
  PRODUCT_PLANS,
  getProductPlansService,
} from "../services/productPlansService.js";
import {
  paymentsEnabled,
  createProductCheckout,
  verifyPaymentEvent,
} from "../services/productPaymentService.js";
import { APP_SUBSCRIPTIONS } from "../services/appSubscriptionCatalog.js";
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
      // Example prices only; nothing is sold or charged (РАДКО 28.11.2026).
      appSubscriptions: APP_SUBSCRIPTIONS,
    }),
  );
  router.get("/usage", requireOwnerSession, async (req, res) => {
    try {
      res.json(await getProductPlansService().usage(req.owner));
    } catch (e) {
      failure(res, e);
    }
  });
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
        res.json(await createProductCheckout(req.owner, req.body.plan));
      } catch (e) {
        failure(res, e);
      }
    },
  );
  return router;
}
export async function productWebhook(req, res) {
  try {
    if (!paymentsEnabled())
      return res.status(503).json({ error: "Плащанията не са активирани." });
    const event = verifyPaymentEvent(req.body, req.headers["stripe-signature"]);
    if (event.livemode !== true)
      return res.status(400).json({ error: "Не се приемат тестови плащания." });
    if (event.type === "checkout.session.completed")
      await getProductPlansService().fulfill(event.data?.object);
    return res.json({ received: true });
  } catch (e) {
    return failure(res, e);
  }
}
