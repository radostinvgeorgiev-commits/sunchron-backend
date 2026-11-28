import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import request from "supertest";

import {
  APP_SUBSCRIPTIONS,
  APP_SUBSCRIPTION_MARKUP_PERCENT,
  withMarkup,
} from "../src/services/appSubscriptionCatalog.js";
import { createProductRouter } from "../src/routes/productRouter.js";

const readPublic = (file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8");

// РАДКО 28.11.2026: „за сега … с примерни цени“ — the app's price plus 10%,
// nothing sold or charged.
test("every app costs its own example price plus 10%", () => {
  assert.equal(APP_SUBSCRIPTION_MARKUP_PERCENT, 10);
  assert.equal(withMarkup(1000), 1100);
  assert.equal(withMarkup(199), 219);
  assert.equal(APP_SUBSCRIPTIONS.examplePrices, true);
  assert.equal(APP_SUBSCRIPTIONS.charging, false);
  assert.equal(APP_SUBSCRIPTIONS.currency, "EUR");
  assert.ok(APP_SUBSCRIPTIONS.items.length >= 4);
  const ids = new Set();
  for (const item of APP_SUBSCRIPTIONS.items) {
    assert.ok(!ids.has(item.id), item.id);
    ids.add(item.id);
    assert.ok(Number.isInteger(item.baseCents) && item.baseCents > 0, item.id);
    assert.equal(item.priceCents, Math.round(item.baseCents * 1.1), item.id);
    assert.ok(item.app && item.maker, item.id);
  }
});

test("the plans answer carries the example prices and payments stay off", async () => {
  const previous = process.env.PRODUCT_PAYMENTS_ENABLED;
  delete process.env.PRODUCT_PAYMENTS_ENABLED;
  try {
    const app = express();
    app.use("/api/product", createProductRouter());
    const response = await request(app).get("/api/product/plans").expect(200);
    assert.equal(response.body.paymentsEnabled, false);
    assert.equal(response.body.appSubscriptions.examplePrices, true);
    assert.equal(response.body.appSubscriptions.charging, false);
    assert.deepEqual(
      response.body.appSubscriptions.items.map(({ id, priceCents }) => [id, priceCents]),
      APP_SUBSCRIPTIONS.items.map(({ id, priceCents }) => [id, priceCents]),
    );
  } finally {
    if (previous === undefined) delete process.env.PRODUCT_PAYMENTS_ENABLED;
    else process.env.PRODUCT_PAYMENTS_ENABLED = previous;
  }
});

test("the plans page shows the example prices without any way to pay for them", async () => {
  const [page, script, english] = await Promise.all([
    readPublic("plans.html"),
    readPublic("plans.js"),
    readPublic("locale-en.js"),
  ]);
  assert.match(page, /id="app-subscriptions"/u);
  assert.match(page, /Цените са примерни: цената на самото приложение плюс 10%/u);
  assert.match(page, /Още нищо\s+не се продава и не се таксува\./u);
  // The cards are text only: no button, no link, no checkout call.
  const render = script.slice(
    script.indexOf("function renderAppSubscriptions"),
    script.indexOf("async function refreshUsage"),
  );
  assert.ok(render.length > 100);
  assert.doesNotMatch(render, /button|checkout|href|fetch\(/u);
  assert.match(render, /Примерна цена · още не се продава/u);
  for (const text of [
    "Абонаменти за приложенията ти",
    "Цена на приложението: {price} на месец",
    "При нас: {price} на месец",
    "Примерна цена · още не се продава",
  ]) {
    assert.ok(english.includes(`\n${text}|`), text);
  }
});
