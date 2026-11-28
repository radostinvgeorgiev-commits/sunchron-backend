import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const readPublic = (file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
const [english, locale, plans, plansScript] = await Promise.all(
  ["locale-en.js", "locale.js", "plans.html", "plans.js"].map(readPublic),
);

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

async function renderPlans({ path, catalog, usage, paymentStatus }) {
  const dom = new JSDOM(plans, {
    url: `https://novariumai.com${path}`,
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const requests = [];
  const questions = [];
  window.confirm = (question) => {
    questions.push(question);
    return true;
  };
  window.fetch = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === "/api/product/plans") return json(catalog);
    if (endpoint === "/api/product/usage") return json(usage);
    if (endpoint.startsWith("/api/product/payment-status"))
      return json(paymentStatus);
    if (endpoint === "/api/product/checkout")
      return json({ url: "https://checkout.stripe.com/c/pay/cs_test_a1" });
    return json({}, 404);
  };
  window.eval(english);
  window.eval(locale);
  window.eval(plansScript);
  await window.NovariumLocale.ready;
  return { window, requests, questions };
}

async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const catalog = (paymentsEnabled) => ({
  plans: [
    { id: "free", name: "Старт", amountCents: 0, credits: 100, days: 30 },
    { id: "personal", name: "Личен", amountCents: 299, credits: 300, days: 30 },
  ],
  paymentsEnabled,
  currency: "EUR",
});
const usage = (payments) => ({
  plan: "free",
  remaining: 100,
  expiresAt: Date.UTC(2026, 11, 28),
  owner: false,
  account: "a".repeat(64),
  payments,
});

test("with real payments on, the page names Google Pay and Apple Pay and sends the page language", async () => {
  const { window, requests, questions } = await renderPlans({
    path: "/plans?lang=en",
    catalog: catalog(true),
    usage: usage({ mode: "live", available: true }),
  });
  const status = window.document.getElementById("payment-status");
  const button = window.document.querySelector('[data-plan="personal"]');
  await until(() => !button.disabled && /Google Pay/u.test(status.textContent));
  assert.match(status.textContent, /Pay with Google Pay, Apple Pay or a card through Stripe/u);
  assert.equal(button.textContent, "Select package");
  button.click();
  await until(() => requests.some((r) => r.endpoint === "/api/product/checkout"));
  assert.match(questions[0], /^Personal: .*Google Pay, Apple Pay or a card\. Continue\?$/u);
  const checkout = requests.find((r) => r.endpoint === "/api/product/checkout");
  assert.deepEqual(JSON.parse(checkout.options.body), {
    plan: "personal",
    confirmed: true,
    language: "en",
  });
});

test("test money is offered only to a listed test account and is clearly marked", async () => {
  const listed = await renderPlans({
    path: "/plans?lang=en",
    catalog: catalog(false),
    usage: usage({ mode: "test", available: true }),
  });
  const status = listed.window.document.getElementById("payment-status");
  const button = listed.window.document.querySelector('[data-plan="personal"]');
  await until(() => !button.disabled);
  assert.match(status.textContent, /^Test mode: you pay with Stripe test money/u);
  button.click();
  await until(() => listed.questions.length > 0);
  assert.match(listed.questions[0], /^Test payment, no real money\. Personal: /u);

  const everyoneElse = await renderPlans({
    path: "/plans?lang=en",
    catalog: catalog(false),
    usage: usage({ mode: "test", available: false }),
  });
  const otherStatus = everyoneElse.window.document.getElementById("payment-status");
  const otherButton = everyoneElse.window.document.querySelector('[data-plan="personal"]');
  await until(() => /not enabled/u.test(otherStatus.textContent) && everyoneElse.requests.some((r) => r.endpoint === "/api/product/usage"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(otherButton.disabled, true);
  assert.equal(otherButton.textContent, "Payments coming later");
});

test("after paying, the page says by itself that the credits arrived", async () => {
  const { window, requests } = await renderPlans({
    path: "/plans?lang=en&payment=processing&session_id=cs_test_a1B2",
    catalog: catalog(true),
    usage: usage({ mode: "live", available: true }),
    paymentStatus: { status: "applied", credits: 300 },
  });
  const status = window.document.getElementById("payment-status");
  assert.match(status.textContent, /still being confirmed/u);
  await until(() => /^Done: 300 AI credits were added/u.test(status.textContent));
  const asked = requests.find((r) => r.endpoint.startsWith("/api/product/payment-status"));
  assert.equal(asked.endpoint, "/api/product/payment-status?session=cs_test_a1B2");
});

test("a return address without a valid payment number does not start checking", async () => {
  const { window, requests } = await renderPlans({
    path: "/plans?lang=en&payment=processing&session_id=../../admin",
    catalog: catalog(true),
    usage: usage({ mode: "live", available: true }),
  });
  const status = window.document.getElementById("payment-status");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.match(status.textContent, /^Payment is processing/u);
  assert.equal(
    requests.some((r) => r.endpoint.startsWith("/api/product/payment-status")),
    false,
  );
});
