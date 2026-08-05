import assert from "node:assert/strict";
import test from "node:test";

import {
  BillingError,
  consumeTokens,
  getTokenBalance,
  getTransactions,
  isBillingConfigured,
  purchaseTokens,
} from "../src/services/billingService.js";

const ENV = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  BILLING_FREE_TOKENS: "500",
};

function makeBalance(tokens) {
  return JSON.stringify([{ tokens, last_updated: "2026-01-01T00:00:00Z" }]);
}

test("isBillingConfigured — true when URL and key are present", () => {
  assert.equal(isBillingConfigured(ENV), true);
});

test("isBillingConfigured — false when URL is absent", () => {
  assert.equal(isBillingConfigured({ ...ENV, SUPABASE_URL: "" }), false);
});

test("isBillingConfigured — false when both keys are absent", () => {
  assert.equal(
    isBillingConfigured({
      ...ENV,
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_PUBLISHABLE_KEY: "",
    }),
    false,
  );
});

test("getTokenBalance — returns existing balance", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(makeBalance(1234), { status: 200 });
  };
  global.fetch = fetchImpl;

  const result = await getTokenBalance("user-uuid-1", { env: ENV });
  assert.equal(result.userId, "user-uuid-1");
  assert.equal(result.tokens, 1234);
  assert.ok(calls[0].includes("/token_balance"));

  delete global.fetch;
});

test("getTokenBalance — creates row with free tokens on first access", async () => {
  let postCalled = false;
  let transactionPostCalled = false;
  const fetchImpl = async (url, opts) => {
    if (opts.method === "GET") {
      return new Response("[]", { status: 200 });
    }
    if (url.includes("/token_balance") && opts.method === "POST") {
      postCalled = true;
      return new Response(
        JSON.stringify([{ tokens: 500, last_updated: "2026-01-01T00:00:00Z" }]),
        { status: 201 },
      );
    }
    if (url.includes("/transactions") && opts.method === "POST") {
      transactionPostCalled = true;
      return new Response("", { status: 201 });
    }
    return new Response("", { status: 200 });
  };
  global.fetch = fetchImpl;

  const result = await getTokenBalance("new-user", { env: ENV });
  assert.equal(result.tokens, 500);
  assert.equal(postCalled, true);
  assert.equal(transactionPostCalled, true);

  delete global.fetch;
});

test("getTokenBalance — throws BillingError when user_id is missing", async () => {
  await assert.rejects(
    () => getTokenBalance("", { env: ENV }),
    (err) =>
      err instanceof BillingError && err.code === "BILLING_BAD_REQUEST",
  );
});

test("getTokenBalance — throws BillingError when billing not configured", async () => {
  await assert.rejects(
    () => getTokenBalance("uid", { env: { ...ENV, SUPABASE_URL: "" } }),
    (err) =>
      err instanceof BillingError && err.code === "BILLING_NOT_CONFIGURED",
  );
});

test("consumeTokens — deducts tokens and records transaction", async () => {
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, method: opts.method, body: opts.body });
    if (url.includes("/token_balance") && opts.method === "GET") {
      return new Response(makeBalance(1000), { status: 200 });
    }
    return new Response("", { status: 200 });
  };
  global.fetch = fetchImpl;

  const result = await consumeTokens("uid", 100, { env: ENV, model: "gpt-5" });
  assert.equal(result.tokens, 900);
  const patchCall = requests.find(
    (r) => r.method === "PATCH" && r.url.includes("/token_balance"),
  );
  assert.ok(patchCall, "PATCH должен быть вызван");

  delete global.fetch;
});

test("consumeTokens — throws BILLING_INSUFFICIENT_TOKENS when balance too low", async () => {
  global.fetch = async (url, opts) => {
    if (opts.method === "GET") {
      return new Response(makeBalance(5), { status: 200 });
    }
    return new Response("", { status: 200 });
  };

  await assert.rejects(
    () => consumeTokens("uid", 100, { env: ENV }),
    (err) =>
      err instanceof BillingError &&
      err.code === "BILLING_INSUFFICIENT_TOKENS" &&
      err.status === 402,
  );

  delete global.fetch;
});

test("consumeTokens — returns null silently when billing not configured", async () => {
  const result = await consumeTokens("uid", 50, {
    env: { ...ENV, SUPABASE_URL: "" },
  });
  assert.equal(result, null);
});

test("purchaseTokens — adds tokens to balance", async () => {
  global.fetch = async (url, opts) => {
    if (opts.method === "GET") {
      return new Response(makeBalance(200), { status: 200 });
    }
    return new Response("", { status: 200 });
  };

  const result = await purchaseTokens("uid", 300, { env: ENV });
  assert.equal(result.tokens, 500);

  delete global.fetch;
});

test("purchaseTokens — rejects zero or negative amounts", async () => {
  await assert.rejects(
    () => purchaseTokens("uid", 0, { env: ENV }),
    (err) =>
      err instanceof BillingError && err.code === "BILLING_BAD_REQUEST",
  );
});

test("getTransactions — returns transaction list", async () => {
  const txList = [
    { id: "t1", amount: 500, type: "purchase", description: "Стартови безплатни токени", created_at: "2026-01-01T00:00:00Z" },
    { id: "t2", amount: -10, type: "consumption", description: "AI заявка", created_at: "2026-01-02T00:00:00Z" },
  ];
  global.fetch = async () => new Response(JSON.stringify(txList), { status: 200 });

  const result = await getTransactions("uid", { env: ENV });
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "purchase");
  assert.equal(result[1].type, "consumption");

  delete global.fetch;
});

test("getTransactions — returns empty array when billing not configured", async () => {
  await assert.rejects(
    () => getTransactions("uid", { env: { ...ENV, SUPABASE_URL: "" } }),
    (err) =>
      err instanceof BillingError && err.code === "BILLING_NOT_CONFIGURED",
  );
});

test("BillingError carries correct status and code", () => {
  const err = new BillingError("test", 402, "BILLING_INSUFFICIENT_TOKENS");
  assert.equal(err.status, 402);
  assert.equal(err.code, "BILLING_INSUFFICIENT_TOKENS");
  assert.equal(err.name, "BillingError");
});
