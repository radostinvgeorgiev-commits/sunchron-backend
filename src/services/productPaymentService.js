import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import {
  PRODUCT_PLANS,
  ProductError,
  productAccountId,
} from "./productPlansService.js";
// People pay on Stripe's own checkout page. Stripe shows Google Pay, Apple Pay
// and cards there by itself, so no card data ever reaches this site.
const RETURN_HOSTS = new Set([
  "novariumai.com",
  "www.novariumai.com",
  "cloudaicore.com",
  "www.cloudaicore.com",
]);
const DEFAULT_RETURN_ORIGIN = "https://novariumai.com";
const CHECKOUT_LOCALES = new Set(["bg", "de", "en", "es", "fr", "it", "ro", "tr", "zh"]);
const ENGLISH_PLAN_NAMES = Object.freeze({
  personal: "Personal",
  professional: "Professional",
});
const SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{1,200}$/;
const FULFILLING_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);
function testAccounts(env) {
  return new Set(
    String(env.PRODUCT_PAYMENTS_TEST_ACCOUNTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
  );
}
// "live": real payments for everyone. "test": Stripe test money, only for the
// accounts listed in PRODUCT_PAYMENTS_TEST_ACCOUNTS, so the whole purchase can
// be checked before real payments open. "off": nobody can pay.
export function paymentMode(env = process.env) {
  if (env.PRODUCT_PAYMENTS_ENABLED !== "true" || !env.STRIPE_WEBHOOK_SECRET)
    return "off";
  const key = env.STRIPE_SECRET_KEY || "";
  if (
    /^sk_live_/.test(key) &&
    env.PRODUCT_MERCHANT_READY === "true" &&
    env.PRODUCT_UNIT_ECONOMICS_APPROVED === "true"
  )
    return "live";
  if (/^sk_test_/.test(key) && testAccounts(env).size > 0) return "test";
  return "off";
}
export function paymentsEnabled(env = process.env) {
  return paymentMode(env) === "live";
}
export function paymentsAvailableFor(identity, env = process.env) {
  const mode = paymentMode(env);
  if (mode === "live") return true;
  if (mode !== "test") return false;
  try {
    return testAccounts(env).has(productAccountId(identity));
  } catch {
    return false;
  }
}
// After paying, the person comes back to the same site they started on, so
// they stay signed in. Unknown hosts fall back to the main address.
export function checkoutReturnOrigin(host) {
  const name = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  return RETURN_HOSTS.has(name) ? `https://${name}` : DEFAULT_RETURN_ORIGIN;
}
export function isCheckoutSessionId(value) {
  return SESSION_ID.test(String(value || ""));
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
  { env = process.env, fetchImpl = fetch, host, language } = {},
) {
  if (!paymentsAvailableFor(identity, env))
    throw new ProductError(
      "Плащанията още не са активирани. Няма да бъде начислена сума.",
      "PAYMENTS_NOT_CONFIGURED",
      503,
    );
  const plan = PRODUCT_PLANS.find((p) => p.id === planId && p.amountCents > 0);
  if (!plan)
    throw new ProductError("Избери валиден платен план.", "PLAN_INVALID", 400);
  const locale = CHECKOUT_LOCALES.has(language) ? language : "auto";
  const name =
    language === undefined || locale === "bg"
      ? `NovariumAI · ${plan.name} · ${plan.credits} AI единици / 30 дни`
      : `NovariumAI · ${ENGLISH_PLAN_NAMES[plan.id] || plan.name} · ${plan.credits} AI credits / 30 days`;
  const origin = checkoutReturnOrigin(host);
  // No fixed list of payment methods: Stripe offers what is switched on in
  // its settings (cards, Google Pay, Apple Pay) and only where the person's
  // device supports it.
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(plan.amountCents),
    "line_items[0][price_data][product_data][name]": name,
    "line_items[0][quantity]": "1",
    "metadata[account]": productAccountId(identity),
    "metadata[plan]": plan.id,
    locale,
    success_url: `${origin}/plans?payment=processing&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/plans?payment=cancelled`,
  });
  const configuration = String(env.PRODUCT_STRIPE_PAYMENT_METHOD_CONFIG || "");
  if (/^pmc_[A-Za-z0-9]{1,100}$/.test(configuration))
    params.set("payment_method_configuration", configuration);
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
// Units are added only from Stripe's signed confirmation, never from the
// browser coming back. Delayed payment methods confirm later with
// checkout.session.async_payment_succeeded; until then nothing is added.
export async function handlePaymentEvent(event, { env = process.env, fulfill }) {
  const mode = paymentMode(env);
  if (mode === "off")
    throw new ProductError(
      "Плащанията не са активирани.",
      "PAYMENTS_NOT_CONFIGURED",
      503,
    );
  if (event?.livemode !== (mode === "live"))
    throw new ProductError(
      mode === "live"
        ? "Не се приемат тестови плащания."
        : "Тестовият режим не приема истински плащания.",
      "PAYMENT_MODE_MISMATCH",
      400,
    );
  if (!FULFILLING_EVENTS.has(event.type)) return { ignored: true };
  const session = event.data?.object;
  if (session?.payment_status !== "paid") return { pending: true };
  if (
    mode === "test" &&
    !testAccounts(env).has(String(session.metadata?.account || ""))
  )
    throw new ProductError(
      "Тестовото плащане не е от позволен профил.",
      "PAYMENT_TEST_ACCOUNT",
      400,
    );
  return fulfill(session, { livemode: mode === "live" });
}
