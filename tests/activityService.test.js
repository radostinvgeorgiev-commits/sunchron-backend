import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activityDay,
  campaignField,
  createActivityService,
} from "../src/services/activityService.js";
import { createLocalDocumentStore } from "../src/services/localDocumentStore.js";

const NOW = Date.parse("2026-11-26T20:00:00Z");

test("counts add up per day and one person counts once a day", async () => {
  const store = createLocalDocumentStore();
  const service = createActivityService({ store, now: () => NOW });
  await service.bump({ messages: 1 });
  await service.bump({ messages: 1, landing_variant_2: 1, not_a_field: 5 });
  await service.markActive("user-1");
  await service.markActive("user-1");
  await service.markActive("user-2");
  // A second instance does not know the first one's memory: the stored
  // marker still stops a double count.
  await createActivityService({ store, now: () => NOW }).markActive("user-1");
  const [today, yesterday] = await service.summary(2);
  assert.equal(today.date, "2026-11-26");
  assert.equal(today.messages, 2);
  assert.equal(today.landing_variant_2, 1);
  assert.equal(today.active, 2);
  assert.equal(today.not_a_field, undefined);
  assert.equal(yesterday.date, "2026-11-25");
  assert.equal(yesterday.messages, 0);
});

test("nothing personal is stored", async () => {
  const store = createLocalDocumentStore();
  const service = createActivityService({ store, now: () => NOW });
  await service.markActive("radko@example.com");
  const marker = await store.query("activity_seen", { filters: [{ field: "day", value: "2026-11-26" }] });
  assert.equal(marker.length, 1);
  assert.doesNotMatch(JSON.stringify(marker), /radko|example/u);
});

test("days follow Sofia time and ad variants map to fields", () => {
  assert.equal(activityDay(Date.parse("2026-11-26T22:30:00Z")), "2026-11-27");
  assert.equal(campaignField("landing", { utm_content: "variant-3" }), "landing_variant_3");
  assert.equal(campaignField("landing", { utm_content: "smoke-test" }), "landing_smoke_test");
  assert.equal(campaignField("landing", { utm_content: "evil" }), null);
});

test("the page is the owner's only and the counts are wired in", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /"\/api\/activity",\s*requireOwnerSession,\s*requirePrimaryOwner,/u);
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  assert.match(chat, /recordActivity\(\{ messages: 1 \}\)/u);
  const auth = readFileSync(new URL("../src/routes/userAuthRouter.js", import.meta.url), "utf8");
  // New profiles are made only through Google sign-in now.
  assert.equal((auth.match(/recordActivity\(\{ registrations: 1 \}\)/gu) || []).length, 2);
  const campaign = readFileSync(new URL("../src/services/campaignAttribution.js", import.meta.url), "utf8");
  assert.match(campaign, /recordActivity/u);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="activityBtn" type="button" data-owner-only/u);
});
