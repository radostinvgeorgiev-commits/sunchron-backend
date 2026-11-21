import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import {
  PRODUCT_PLANS,
  ProductError,
  productAccountId,
} from "./productPlansService.js";
export function paymentsEnabled(env = process.env) {
  return (
    env.PRODUCT_PAYMENTS_ENABLED === "true" &&
    /^sk_live_/.test(env.STRIPE_SECRET_KEY || "") &&
    Boolean(env.STRIPE_WEBHOOK_SECRET) &&
    env.PRODUCT_MERCHANT_READY === "true" &&
    env.PRODUCT_UNIT_ECONOMICS_APPROVED === "true"
  );
}
export function verifyPaymentEvent(
  body,
  signature,
  env = process.env,
  now = Date.now(),
) {
  const parts = String(signature || "").split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (
    !Buffer.isBuffer(body) ||
    !env.STRIPE_WEBHOOK_SECRET ||
    !/^\d+$/.test(timestamp || "") ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    throw new ProductError(
      "Невалиден подпис.",
      "PAYMENT_SIGNATURE_INVALID",
      400,
    );
  const expected = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  if (
    !signatures.some(
      (s) =>
        /^[a-f0-9]{64}$/.test(s) &&
        timingSafeEqual(expected, Buffer.from(s, "hex")),
    )
  )
    throw new ProductError(
      "Невалиден подпис.",
      "PAYMENT_SIGNATURE_INVALID",
      400,
    );
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ProductError("Невалидно събитие.", "PAYMENT_EVENT_INVALID", 400);
  }
}
export async function createProductCheckout(
  identity,
  planId,
  { env = process.env, fetchImpl = fetch } = {},
) {
  if (!paymentsEnabled(env))
    throw new ProductError(
      "Плащанията още не са активирани. Няма да бъде начислена сума.",
      "PAYMENTS_NOT_CONFIGURED",
      503,
    );
  const plan = PRODUCT_PLANS.find((p) => p.id === planId && p.amountCents > 0);
  if (!plan)
    throw new ProductError("Избери валиден платен план.", "PLAN_INVALID", 400);
  const params = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(plan.amountCents),
    "line_items[0][price_data][product_data][name]": `SYNCHRON-X · ${plan.name} · ${plan.credits} AI единици / 30 дни`,
    "line_items[0][quantity]": "1",
    "metadata[account]": productAccountId(identity),
    "metadata[plan]": plan.id,
    success_url: "https://cloudaicore.com/plans?payment=processing",
    cancel_url: "https://cloudaicore.com/plans?payment=cancelled",
  });
  const response = await fetchImpl(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": randomUUID(),
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new ProductError(
      "Плащането не можа да бъде подготвено. Опитай по-късно.",
    );
  const session = await response.json();
  let url;
  try {
    url = new URL(session.url);
  } catch {
    throw new ProductError("Невалиден платежен адрес.");
  }
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
    throw new ProductError("Невалиден платежен адрес.");
  return { url: session.url };
}
