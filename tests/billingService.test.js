import assert from "node:assert/strict";
import test from "node:test";

import {
  BillingError,
  deductTokens,
  getBalance,
  getTransactionHistory,
  purchaseTokens,
  AI_CALL_COST_TOKENS,
  TOKENS_PER_EURO,
} from "../src/services/billingService.js";

// ── fake OpenSearch client ───────────────────────────────────────────────────

function makeFakeClient({ initialDocs = {} } = {}) {
  const docs = { ...initialDocs };
  return {
    indices: {
      async exists() {
        return { body: true };
      },
    },
    async get({ id }) {
      if (Object.prototype.hasOwnProperty.call(docs, id)) {
        return { body: { _id: id, _source: docs[id] } };
      }
      const err = new Error("not found");
      err.meta = { statusCode: 404 };
      throw err;
    },
    async index({ id, body }) {
      if (id) docs[id] = body;
      return { body: { result: "created" } };
    },
    async update({ id, body }) {
      const source = body.script?.source || "";
      const params = body.script?.params || {};
      let current = Object.prototype.hasOwnProperty.call(docs, id)
        ? docs[id]
        : body.upsert
          ? { ...body.upsert }
          : { balance: 0 };

      if (!Object.prototype.hasOwnProperty.call(docs, id) && body.upsert) {
        docs[id] = current;
      }

      if (source.includes("ctx._source.balance -= params.cost")) {
        if (current.balance >= params.cost) {
          current.balance -= params.cost;
          docs[id] = current;
          return { body: { result: "updated" } };
        }
        return { body: { result: "noop" } };
      }
      if (source.includes("(ctx._source.balance ?: 0) + params.tokens")) {
        current.balance = (current.balance || 0) + params.tokens;
        docs[id] = current;
        return { body: { result: "updated" } };
      }
      return { body: { result: "updated" } };
    },
    async search({ body }) {
      const userId = body.query?.bool?.filter?.find((f) => f.term?.userId)
        ?.term.userId;
      const hits = Object.values(docs)
        .filter(
          (d) =>
            d.type === "transaction" && (!userId || d.userId === userId),
        )
        .map((d) => ({ _source: d }));
      return { body: { hits: { hits } } };
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("getBalance creates a trial balance for a new user", async () => {
  const osClient = makeFakeClient();
  const result = await getBalance("user-new", { osClient });
  assert.equal(result.userId, "user-new");
  assert.equal(result.balance, 100);
});

test("getBalance returns the existing balance", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "balance:user-exists": {
        type: "balance",
        userId: "user-exists",
        balance: 500,
      },
    },
  });
  const result = await getBalance("user-exists", { osClient });
  assert.equal(result.balance, 500);
});

test("getBalance rejects missing userId", async () => {
  const osClient = makeFakeClient();
  await assert.rejects(
    () => getBalance("", { osClient }),
    (e) => e instanceof BillingError && e.code === "BILLING_MISSING_USER",
  );
});

test("deductTokens deducts from balance and returns new balance", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "balance:user-a": { type: "balance", userId: "user-a", balance: 200 },
    },
  });
  const newBalance = await deductTokens("user-a", AI_CALL_COST_TOKENS, "test", {
    osClient,
  });
  assert.equal(newBalance, 200 - AI_CALL_COST_TOKENS);
});

test("deductTokens throws INSUFFICIENT_TOKENS when balance is too low", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "balance:user-b": { type: "balance", userId: "user-b", balance: 5 },
    },
  });
  await assert.rejects(
    () => deductTokens("user-b", 10, "test", { osClient }),
    (e) =>
      e instanceof BillingError &&
      e.code === "INSUFFICIENT_TOKENS" &&
      e.status === 402,
  );
});

test("purchaseTokens credits tokens and returns newBalance (simulated)", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "balance:user-c": { type: "balance", userId: "user-c", balance: 0 },
    },
  });
  const originalStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  try {
    const result = await purchaseTokens({
      userId: "user-c",
      euros: 1,
      osClient,
    });
    assert.equal(result.tokens, TOKENS_PER_EURO);
    assert.equal(result.newBalance, TOKENS_PER_EURO);
    assert.match(result.paymentIntentId, /^sim_/u);
  } finally {
    if (originalStripe !== undefined)
      process.env.STRIPE_SECRET_KEY = originalStripe;
  }
});

test("purchaseTokens rejects non-integer euros", async () => {
  const osClient = makeFakeClient();
  await assert.rejects(
    () => purchaseTokens({ userId: "user-d", euros: 0.5, osClient }),
    (e) => e instanceof BillingError && e.code === "BILLING_INVALID_AMOUNT",
  );
});

test("purchaseTokens rejects zero euros", async () => {
  const osClient = makeFakeClient();
  await assert.rejects(
    () => purchaseTokens({ userId: "user-e", euros: 0, osClient }),
    (e) => e instanceof BillingError && e.code === "BILLING_INVALID_AMOUNT",
  );
});

test("getTransactionHistory returns transactions for user", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "tx-1": {
        type: "transaction",
        userId: "user-f",
        amount: 10,
        direction: "debit",
        createdAt: "2026-01-01",
      },
    },
  });
  const txs = await getTransactionHistory("user-f", 20, { osClient });
  assert.ok(Array.isArray(txs));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].userId, "user-f");
});

test("BillingError carries status and code", () => {
  const err = new BillingError("test", 402, "INSUFFICIENT_TOKENS");
  assert.equal(err.status, 402);
  assert.equal(err.code, "INSUFFICIENT_TOKENS");
  assert.equal(err.name, "BillingError");
});

test("AI_CALL_COST_TOKENS and TOKENS_PER_EURO are positive numbers", () => {
  assert.ok(AI_CALL_COST_TOKENS > 0);
  assert.ok(TOKENS_PER_EURO > 0);
});

test("purchaseTokens uses Stripe when STRIPE_SECRET_KEY is set", async () => {
  const osClient = makeFakeClient({
    initialDocs: {
      "balance:user-g": { type: "balance", userId: "user-g", balance: 0 },
    },
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  try {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ id: "pi_test123", status: "succeeded" }),
    });
    const result = await purchaseTokens({
      userId: "user-g",
      euros: 2,
      stripePaymentMethodId: "pm_test",
      osClient,
      fetchImpl: fakeFetch,
    });
    assert.equal(result.tokens, 2 * TOKENS_PER_EURO);
    assert.equal(result.paymentIntentId, "pi_test123");
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});
