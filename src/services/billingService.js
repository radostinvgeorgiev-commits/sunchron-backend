/**
 * Billing service — manages per-user AI token balances and purchase history.
 *
 * Storage: OpenSearch index `synchron-billing-v1`.
 * Each user has one balance document (doc id = userId) and many transaction
 * documents in the same index.
 *
 * Stripe integration is optional.  When STRIPE_SECRET_KEY is not set the
 * purchase endpoint is still available but processes payments in a "simulated"
 * mode that is suitable for testing.
 *
 * All public functions accept an optional `{ osClient }` injection object so
 * that tests can pass a fake client without monkey-patching the module.
 */

import { getOpenSearchClient } from "../config/opensearch.js";

const BILLING_INDEX = process.env.BILLING_INDEX || "synchron-billing-v1";

export const TOKENS_PER_EURO = 10_000; // 1 € = 10 000 tokens
export const AI_CALL_COST_TOKENS = 10; // default cost per AI request
const TRIAL_TOKENS = 100; // granted on first balance check

export class BillingError extends Error {
  constructor(message, status = 400, code = "BILLING_ERROR") {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function balanceDocId(userId) {
  return `balance:${userId}`;
}

function resolveClient(injected) {
  const c = injected || getOpenSearchClient();
  if (!c) {
    throw new BillingError(
      "Базата данни за плащания не е конфигурирана.",
      503,
      "BILLING_STORAGE_UNAVAILABLE",
    );
  }
  return c;
}

async function ensureIndex(os) {
  const exists = await os.indices.exists({ index: BILLING_INDEX });
  if (exists.body) return;
  await os.indices.create({
    index: BILLING_INDEX,
    body: {
      mappings: {
        properties: {
          type: { type: "keyword" },
          userId: { type: "keyword" },
          balance: { type: "long" },
          amount: { type: "long" },
          direction: { type: "keyword" },
          description: { type: "keyword" },
          stripePaymentIntentId: { type: "keyword" },
          createdAt: { type: "date" },
        },
      },
    },
  });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current token balance for userId.
 * Creates a trial balance document if none exists yet.
 */
export async function getBalance(userId, { osClient } = {}) {
  if (!userId)
    throw new BillingError("userId е задължителен.", 400, "BILLING_MISSING_USER");

  const os = resolveClient(osClient);
  await ensureIndex(os);

  const docId = balanceDocId(userId);
  try {
    const result = await os.get({ index: BILLING_INDEX, id: docId });
    return {
      userId,
      balance: Number(result.body._source.balance ?? 0),
    };
  } catch (err) {
    if (err?.meta?.statusCode === 404 || err?.statusCode === 404) {
      // First access — grant trial tokens.
      const trialDoc = {
        type: "balance",
        userId,
        balance: TRIAL_TOKENS,
        createdAt: new Date().toISOString(),
      };
      await os.index({
        index: BILLING_INDEX,
        id: docId,
        body: trialDoc,
        refresh: "true",
      });
      return { userId, balance: TRIAL_TOKENS };
    }
    throw new BillingError(
      "Неуспешно четене на баланса.",
      503,
      "BILLING_READ_ERROR",
    );
  }
}

/**
 * Deducts `cost` tokens from userId's balance atomically.
 * Returns the new balance.
 * Throws BillingError with code INSUFFICIENT_TOKENS when balance < cost.
 */
export async function deductTokens(
  userId,
  cost = AI_CALL_COST_TOKENS,
  description = "AI заявка",
  { osClient } = {},
) {
  if (!userId)
    throw new BillingError("userId е задължителен.", 400, "BILLING_MISSING_USER");
  const numCost = Number(cost);
  if (!Number.isFinite(numCost) || numCost < 0) {
    throw new BillingError(
      "Невалидна цена на заявката.",
      400,
      "BILLING_INVALID_COST",
    );
  }

  const os = resolveClient(osClient);
  await ensureIndex(os);

  // Check balance first.
  const { balance } = await getBalance(userId, { osClient: os });
  if (balance < numCost) {
    throw new BillingError(
      `Insufficient tokens. Баланс: ${balance}, необходими: ${numCost}.`,
      402,
      "INSUFFICIENT_TOKENS",
    );
  }

  const docId = balanceDocId(userId);
  const updateResult = await os.update({
    index: BILLING_INDEX,
    id: docId,
    body: {
      script: {
        source:
          "if (ctx._source.balance >= params.cost) { ctx._source.balance -= params.cost } else { ctx.op = 'none' }",
        params: { cost: numCost },
      },
    },
    refresh: "true",
  });

  if (updateResult.body.result === "noop") {
    throw new BillingError(`Insufficient tokens.`, 402, "INSUFFICIENT_TOKENS");
  }

  // Record transaction.
  await os.index({
    index: BILLING_INDEX,
    body: {
      type: "transaction",
      userId,
      amount: numCost,
      direction: "debit",
      description,
      createdAt: new Date().toISOString(),
    },
    refresh: "false",
  });

  const updated = await getBalance(userId, { osClient: os });
  return updated.balance;
}

/**
 * Adds tokens to userId's balance and records a credit transaction.
 */
async function creditTokens(
  os,
  userId,
  tokens,
  description,
  stripePaymentIntentId = null,
) {
  const docId = balanceDocId(userId);

  await os.update({
    index: BILLING_INDEX,
    id: docId,
    body: {
      script: {
        source:
          "ctx._source.balance = (ctx._source.balance ?: 0) + params.tokens",
        params: { tokens },
      },
      upsert: {
        type: "balance",
        userId,
        balance: tokens,
        createdAt: new Date().toISOString(),
      },
    },
    refresh: "true",
  });

  const txDoc = {
    type: "transaction",
    userId,
    amount: tokens,
    direction: "credit",
    description,
    createdAt: new Date().toISOString(),
  };
  if (stripePaymentIntentId) txDoc.stripePaymentIntentId = stripePaymentIntentId;

  await os.index({ index: BILLING_INDEX, body: txDoc, refresh: "false" });

  const updated = await getBalance(userId, { osClient: os });
  return updated.balance;
}

/**
 * Processes a token purchase.
 * When STRIPE_SECRET_KEY is configured the payment is processed with Stripe.
 * Otherwise the purchase is simulated (useful for testing / staging).
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {number} opts.euros  — amount in whole euros (min 1)
 * @param {string} [opts.stripePaymentMethodId]  — required in production
 * @param {object} [opts.osClient]  — injectable OpenSearch client
 * @param {Function} [opts.fetchImpl]  — injectable fetch (for tests)
 * @returns {{ tokens, newBalance, paymentIntentId }}
 */
export async function purchaseTokens({
  userId,
  euros,
  stripePaymentMethodId,
  osClient,
  fetchImpl = fetch,
} = {}) {
  if (!userId)
    throw new BillingError("userId е задължителен.", 400, "BILLING_MISSING_USER");
  const numEuros = Number(euros);
  if (
    !Number.isFinite(numEuros) ||
    numEuros < 1 ||
    !Number.isInteger(numEuros)
  ) {
    throw new BillingError(
      "Сумата трябва да е цяло число евро (минимум 1).",
      400,
      "BILLING_INVALID_AMOUNT",
    );
  }

  const tokens = numEuros * TOKENS_PER_EURO;
  let paymentIntentId = null;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    if (!stripePaymentMethodId) {
      throw new BillingError(
        "stripePaymentMethodId е задължителен за реално плащане.",
        400,
        "BILLING_MISSING_PAYMENT_METHOD",
      );
    }
    paymentIntentId = await chargeStripe({
      stripeKey,
      amountCents: numEuros * 100,
      paymentMethodId: stripePaymentMethodId,
      userId,
      fetchImpl,
    });
  } else {
    // Simulated payment (no Stripe key).
    paymentIntentId = `sim_${Date.now()}_${userId.slice(0, 8)}`;
  }

  const os = resolveClient(osClient);
  await ensureIndex(os);

  const newBalance = await creditTokens(
    os,
    userId,
    tokens,
    `Покупка ${numEuros} € — ${tokens} токена`,
    paymentIntentId,
  );

  return { tokens, newBalance, paymentIntentId };
}

/**
 * Returns the last `limit` transactions for userId (most recent first).
 */
export async function getTransactionHistory(userId, limit = 20, { osClient } = {}) {
  if (!userId)
    throw new BillingError("userId е задължителен.", 400, "BILLING_MISSING_USER");

  const os = resolveClient(osClient);
  await ensureIndex(os);

  const result = await os.search({
    index: BILLING_INDEX,
    body: {
      query: {
        bool: {
          filter: [
            { term: { userId } },
            { term: { type: "transaction" } },
          ],
        },
      },
      sort: [{ createdAt: { order: "desc" } }],
      size: Math.min(Number(limit) || 20, 100),
    },
  });

  return result.body.hits.hits.map((h) => h._source);
}

// ── Stripe helper ─────────────────────────────────────────────────────────────

async function chargeStripe({
  stripeKey,
  amountCents,
  paymentMethodId,
  userId,
  fetchImpl = fetch,
}) {
  const stripeUrl = "https://api.stripe.com/v1/payment_intents";
  const body = new URLSearchParams({
    amount: String(amountCents),
    currency: "eur",
    payment_method: paymentMethodId,
    confirm: "true",
    "metadata[userId]": userId,
    "automatic_payment_methods[enabled]": "false",
  });

  const response = await fetchImpl(stripeUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = payload?.error?.message || "Stripe плащането се провали.";
    throw new BillingError(msg, 402, "BILLING_PAYMENT_FAILED");
  }

  if (payload.status !== "succeeded") {
    throw new BillingError(
      "Stripe статус: " + payload.status + ". Плащането не е завършено.",
      402,
      "BILLING_PAYMENT_INCOMPLETE",
    );
  }

  return payload.id;
}
