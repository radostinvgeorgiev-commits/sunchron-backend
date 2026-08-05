import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, billingJs] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
]);

test("index.html contains token balance section", () => {
  assert.match(html, /id="tokenBalanceSection"/u);
  assert.match(html, /id="tokenBalanceDisplay"/u);
  assert.match(html, /id="buyTokensBtn"/u);
});

test("index.html contains purchase tokens modal", () => {
  assert.match(html, /id="purchaseTokensModal"/u);
  assert.match(html, /id="purchaseTokensForm"/u);
  assert.match(html, /id="purchaseEuros"/u);
  assert.match(html, /id="confirmPurchaseBtn"/u);
  assert.match(html, /id="cancelPurchaseBtn"/u);
});

test("billing.js calls /api/billing/balance", () => {
  assert.match(billingJs, /\/api\/billing\/balance/u);
});

test("billing.js calls /api/billing/purchase-tokens with POST", () => {
  assert.match(billingJs, /\/api\/billing\/purchase-tokens/u);
  assert.match(billingJs, /method.*POST/u);
});

test("billing.js shows balance for non-owner users only", () => {
  assert.match(billingJs, /role.*owner/u);
  assert.match(billingJs, /tokenBalanceSection\.hidden/u);
});

test("billing.js listens for synchron:auth event", () => {
  assert.match(billingJs, /synchron:auth/u);
});

test("billing.js handles insufficient tokens event", () => {
  assert.match(billingJs, /synchron:insufficient_tokens/u);
});

test("index.html loads billing.js", () => {
  assert.match(html, /billing\.js/u);
});
