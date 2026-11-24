import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createProductPlansService,
  productAccountId,
  ACCOUNT_COLLECTION,
} from "../src/services/productPlansService.js";
import {
  verifyPaymentEvent,
  createProductCheckout,
  paymentsEnabled,
} from "../src/services/productPaymentService.js";
import {
  registerUser,
  isUserRegistrationEnabled,
  signInUser,
} from "../src/services/userAuthService.js";
const member = { role: "member", memoryOwnerId: "identity-platform:one" };
const other = { role: "member", memoryOwnerId: "identity-platform:two" };
const now = () => Date.UTC(2026, 10, 21);
function memoryStore() {
  const rows = new Map();
  let version = 0;
  return {
    async get(c, id) {
      const row = rows.get(c + "/" + id);
      return row ? structuredClone(row) : null;
    },
    async commitOperations(ops) {
      for (const op of ops) {
        const row = rows.get(op.collection + "/" + op.id);
        if (
          (op.createOnly && row) ||
          (op.updateTime && row?.updateTime !== op.updateTime)
        ) {
          const e = new Error("conflict");
          e.upstreamStatus = 409;
          throw e;
        }
      }
      for (const op of ops)
        rows.set(op.collection + "/" + op.id, {
          data: structuredClone(op.data),
          updateTime: String(++version),
        });
    },
    rows,
  };
}
test("concurrent usage cannot overspend or cross user boundaries", async () => {
  const store = memoryStore();
  const service = createProductPlansService({ store, now });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => service.reserve(member, 3)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await service.usage(member)).remaining, 1);
  assert.equal((await service.usage(other)).remaining, 10);
  assert.ok(
    store.rows.has(ACCOUNT_COLLECTION + "/" + productAccountId(member)),
  );
});
test("shared capacity cap is atomic across accounts and fails closed on storage failure", async () => {
  const store = memoryStore();
  const service = createProductPlansService({
    store,
    now,
    env: { PUBLIC_AI_DAILY_CREDIT_CAP: "3" },
  });
  const r = await Promise.allSettled([
    service.reserve(member, 3),
    service.reserve(other, 3),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    r.find((x) => x.status === "rejected").reason.code,
    "AI_CAPACITY_LIMIT",
  );
  const broken = createProductPlansService({
    store: {
      get: async () => {
        throw new Error("offline");
      },
    },
    now,
  });
  await assert.rejects(() => broken.reserve(member, 3), /offline/);
});
function paidSession() {
  return {
    id: "cs_live_purchase",
    mode: "payment",
    payment_status: "paid",
    currency: "eur",
    amount_total: 990,
    metadata: { account: productAccountId(member), plan: "personal" },
  };
}
test("paid fulfillment is idempotent, validates amounts and never trusts a browser return", async () => {
  const store = memoryStore();
  const service = createProductPlansService({ store, now });
  const session = paidSession();
  await Promise.all([service.fulfill(session), service.fulfill(session)]);
  assert.equal((await service.usage(member)).remaining, 110);
  assert.equal((await service.usage(other)).remaining, 10);
  await assert.rejects(
    () => service.fulfill({ ...session, amount_total: 1 }),
    (e) => e.code === "PAYMENT_INVALID",
  );
  await assert.rejects(
    () => service.fulfill({ ...session, payment_status: "unpaid" }),
    (e) => e.code === "PAYMENT_INVALID",
  );
});
test("expired trial does not renew itself; paid credits extend access", async () => {
  const store = memoryStore();
  let clock = now();
  const service = createProductPlansService({ store, now: () => clock });
  await service.reserve(member, 3);
  clock += 31 * 86400000;
  assert.equal((await service.usage(member)).remaining, 0);
  await assert.rejects(
    () => service.reserve(member, 3),
    (e) => e.code === "AI_CREDITS_EXHAUSTED",
  );
  await service.fulfill(paidSession());
  assert.equal((await service.usage(member)).remaining, 100);
});
test("webhook signatures reject tampering and old timestamps", () => {
  const env = { STRIPE_WEBHOOK_SECRET: "whsec_test" };
  const body = Buffer.from('{"type":"checkout.session.completed"}');
  const t = String(now() / 1000);
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
    .update(t + ".")
    .update(body)
    .digest("hex");
  assert.equal(
    verifyPaymentEvent(body, `t=${t},v1=${sig}`, env, now()).type,
    "checkout.session.completed",
  );
  assert.throws(() =>
    verifyPaymentEvent(Buffer.from("{}"), `t=${t},v1=${sig}`, env, now()),
  );
  assert.throws(() =>
    verifyPaymentEvent(body, `t=${t},v1=${sig}`, env, now() + 301000),
  );
});
test("checkout is disabled until merchant, economics and payment configuration are ready", async () => {
  assert.equal(paymentsEnabled({}), false);
  await assert.rejects(
    () => createProductCheckout(member, "personal", { env: {} }),
    (e) => e.code === "PAYMENTS_NOT_CONFIGURED",
  );
  const env = {
    PRODUCT_PAYMENTS_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    PRODUCT_MERCHANT_READY: "true",
    PRODUCT_UNIT_ECONOMICS_APPROVED: "true",
  };
  let request;
  const result = await createProductCheckout(member, "personal", {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ url: "https://checkout.stripe.com/c/pay/test" }),
      };
    },
  });
  const params = new URLSearchParams(request.options.body);
  assert.equal(params.get("line_items[0][price_data][unit_amount]"), "990");
  assert.equal(params.get("mode"), "payment");
  assert.equal(params.get("metadata[account]"), productAccountId(member));
  assert.equal(result.url, "https://checkout.stripe.com/c/pay/test");
  await assert.rejects(
    () => createProductCheckout(member, "invented", { env }),
    (e) => e.code === "PLAN_INVALID",
  );
});
test("production public registration needs no invite and cannot recover and reapprove an existing user", async () => {
  const env = {
    NODE_ENV: "production",
    IDENTITY_PLATFORM_PROJECT_ID: "test-project",
    IDENTITY_PLATFORM_API_KEY: "public-api-key",
    USER_SESSION_ENCRYPTION_KEY: "secret-with-more-than-sixteen-characters",
  };
  let approved = 0;
  let recovered = 0;
  const client = {
    auth: {
      signUp: async () => ({
        data: {
          user: { id: "new", email: "x@example.com" },
          session: null,
          confirmationRequired: true,
        },
      }),
      signInWithPassword: async () => {
        recovered++;
        return {};
      },
    },
  };
  const result = await registerUser(
    { email: "x@example.com", password: "safe-password", displayName: "X" },
    { env, client, approveAccess: async () => approved++ },
  );
  assert.equal(approved, 1);
  assert.equal(result.confirmationRequired, true);
  assert.equal(recovered, 0);
  client.auth.signUp = async () => ({ error: { status: 422 }, data: null });
  await assert.rejects(() =>
    registerUser(
      { email: "x@example.com", password: "safe-password" },
      { env, client, approveAccess: async () => approved++ },
    ),
  );
  assert.equal(approved, 1);
  assert.equal(recovered, 0);
});

// All low-level provider calls must inherit a per-request budget, including
// council advisors and fallback attempts. Owners keep their original flow.
test("public budgets cap provider output and charge each attempt before network I/O", async () => {
  const {
    createPublicAiBudgetContext,
    publicAiOutputLimit,
    reservePublicAiCall,
  } = await import("../src/services/publicAiBudget.js");
  const {
    requestOpenAIResponse,
    requestGeminiResponse,
    requestGrokResponse,
  } = await import("../src/services/aiCoreService.js");
  let reserved = 0,
    calls = 0;
  const middleware = createPublicAiBudgetContext({
    reserve: async (identity, credits) => {
      assert.equal(identity, member);
      reserved += credits;
    },
  });
  await middleware({ owner: member }, {}, async () => {
    assert.equal(publicAiOutputLimit(), 1024);
    for (const [provider, invoke] of [
      ["openai", requestOpenAIResponse],
      ["gemini", requestGeminiResponse],
      ["grok", requestGrokResponse],
    ]) {
      await invoke({
        apiKey: "test",
        input: [{ role: "user", content: "Hello" }],
        fetchImpl: async (_url, opts) => {
          calls++;
          assert.equal(reserved, calls * 3);
          const body = JSON.parse(opts.body);
          const max =
            body.max_output_tokens ||
            body.max_tokens ||
            body.generationConfig?.maxOutputTokens;
          assert.equal(max, 1024);
          const payload =
            provider === "openai"
              ? { output_text: "ok" }
              : provider === "gemini"
                ? { candidates: [{ content: { parts: [{ text: "ok" }] } }] }
                : provider === "grok"
                  ? { choices: [{ message: { content: "ok" } }] }
                  : { content: [{ type: "text", text: "ok" }] };
          return { ok: true, json: async () => payload };
        },
      });
    }
    await assert.rejects(
      () => reservePublicAiCall("x".repeat(32001)),
      (e) => e.code === "AI_CONTEXT_LIMIT",
    );
    await reservePublicAiCall("short");
    await reservePublicAiCall("short");
    await reservePublicAiCall("short");
    await assert.rejects(
      () => reservePublicAiCall("short"),
      (e) => e.code === "AI_ATTEMPT_LIMIT",
    );
  });
  assert.equal(publicAiOutputLimit(), null);
  await middleware({ owner: { role: "owner" } }, {}, async () => {
    await reservePublicAiCall("x".repeat(32001));
    assert.equal(publicAiOutputLimit(), null);
  });
  assert.equal(reserved, 18);
});
